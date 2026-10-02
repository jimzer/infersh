// Records system audio and the microphone as two files, through
// ScreenCaptureKit (macOS 15+). Usage: capture <dir>
//
// Writes <dir>/system.caf and <dir>/mic.caf as it goes, so a crash keeps what
// was recorded. Prints one JSON line on stdout when recording starts, and one
// when it stops: on "stop", end of stdin, or SIGTERM. The stop line is also
// written to <dir>/capture.json, for transcribing later. While recording,
// a "level" line every 200 ms gives each track's loudest moment in dBFS.
//
// Tracks are stored as 16 kHz 16-bit mono — what Whisper listens to anyway —
// about 115 MB an hour each. The Mac is kept from idle sleep while recording.
// If macOS ends the stream itself, the files are closed properly and the
// stop line carries the reason. SIGINT is ignored —
// the parent decides when to stop — so Ctrl-C cannot cut a file short.

import AVFoundation
import CoreMedia
import Foundation
import IOKit.pwr_mgt
import ScreenCaptureKit

signal(SIGINT, SIG_IGN)

func emit(_ object: [String: Any]) {
	let data = try! JSONSerialization.data(withJSONObject: object)
	FileHandle.standardOutput.write(data + Data("\n".utf8))
}

func fail(_ message: String) -> Never {
	emit(["type": "error", "message": message])
	exit(1)
}

guard CommandLine.arguments.count == 2 else { fail("usage: capture <dir>") }
let dir = URL(fileURLWithPath: CommandLine.arguments[1])

/** What is written to disk, and what every buffer is converted to first. */
let stored = AVAudioFormat(
	commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
let fileSettings: [String: Any] = [
	AVFormatIDKey: kAudioFormatLinearPCM,
	AVSampleRateKey: 16000,
	AVNumberOfChannelsKey: 1,
	AVLinearPCMBitDepthKey: 16,
	AVLinearPCMIsFloatKey: false,
	AVLinearPCMIsBigEndianKey: false,
]

final class Track {
	let url: URL
	var file: AVAudioFile?
	var converter: AVAudioConverter?
	var start: Double?
	var frames: Int64 = 0
	/** Loudest RMS since the last level report, read and reset on the queue. */
	var peak: Float = 0
	init(_ url: URL) { self.url = url }

	/** Resamples and downmixes one buffer to the stored format. */
	func convert(_ input: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
		if converter == nil || converter!.inputFormat != input.format {
			converter = AVAudioConverter(from: input.format, to: stored)
			converter?.downmix = true
		}
		guard let converter else { return nil }
		let capacity = AVAudioFrameCount(
			Double(input.frameLength) * stored.sampleRate / input.format.sampleRate) + 64
		guard let output = AVAudioPCMBuffer(pcmFormat: stored, frameCapacity: capacity)
		else { return nil }
		var given = false
		var error: NSError?
		converter.convert(to: output, error: &error) { _, status in
			if given {
				status.pointee = .noDataNow
				return nil
			}
			given = true
			status.pointee = .haveData
			return input
		}
		return error == nil ? output : nil
	}

	func write(_ buffer: CMSampleBuffer) {
		guard let description = buffer.formatDescription,
			var asbd = description.audioStreamBasicDescription,
			let format = AVAudioFormat(streamDescription: &asbd)
		else { return }
		let count = AVAudioFrameCount(buffer.numSamples)
		guard count > 0, let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: count)
		else { return }
		pcm.frameLength = count
		let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(
			buffer, at: 0, frameCount: Int32(count), into: pcm.mutableAudioBufferList)
		guard status == noErr, let converted = convert(pcm), converted.frameLength > 0
		else { return }
		do {
			if file == nil {
				file = try AVAudioFile(
					forWriting: url, settings: fileSettings,
					commonFormat: .pcmFormatFloat32, interleaved: false)
				start = buffer.presentationTimeStamp.seconds
			}
			try file?.write(from: converted)
			frames += Int64(converted.frameLength)
			if let samples = converted.floatChannelData?[0] {
				let n = Int(converted.frameLength)
				var sum: Float = 0
				for i in 0..<n { sum += samples[i] * samples[i] }
				peak = max(peak, (sum / Float(n)).squareRoot())
			}
		} catch {
			emit(["type": "warning", "message": "\(url.lastPathComponent): \(error.localizedDescription)"])
		}
	}
}

final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
	let system = Track(dir.appendingPathComponent("system.caf"))
	let mic = Track(dir.appendingPathComponent("mic.caf"))
	let queue = DispatchQueue(label: "capture")

	func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
		switch type {
		case .audio: system.write(buffer)
		case .microphone: mic.write(buffer)
		default: break
		}
	}

	func stream(_ stream: SCStream, didStopWithError error: Error) {
		stop(reason: "macOS stopped the recording: \(error.localizedDescription)")
	}
}

let recorder = Recorder()
var stream: SCStream?
var meter: DispatchSourceTimer?

Task {
	do {
		let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
		guard let display = content.displays.first else { fail("No display found.") }
		let filter = SCContentFilter(display: display, excludingWindows: [])
		let config = SCStreamConfiguration()
		config.capturesAudio = true
		config.captureMicrophone = true
		config.excludesCurrentProcessAudio = true
		config.sampleRate = 48000
		config.channelCount = 1
		// Video cannot be turned off; make it as cheap as possible.
		config.width = 2
		config.height = 2
		config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
		let s = SCStream(filter: filter, configuration: config, delegate: recorder)
		try s.addStreamOutput(recorder, type: .audio, sampleHandlerQueue: recorder.queue)
		try s.addStreamOutput(recorder, type: .microphone, sampleHandlerQueue: recorder.queue)
		try await s.startCapture()
		stream = s
		var assertion: IOPMAssertionID = 0
		IOPMAssertionCreateWithName(
			kIOPMAssertionTypePreventUserIdleSystemSleep as CFString,
			IOPMAssertionLevel(kIOPMAssertionLevelOn),
			"infer meeting is recording" as CFString, &assertion)
		emit(["type": "started"])
		let levels = DispatchSource.makeTimerSource(queue: recorder.queue)
		levels.schedule(deadline: .now(), repeating: .milliseconds(200))
		levels.setEventHandler {
			let decibels = { (rms: Float) -> Double in
				Double(max(-60, 20 * log10(max(rms, 1e-6))))
			}
			emit([
				"type": "level",
				"mic": decibels(recorder.mic.peak),
				"system": decibels(recorder.system.peak),
			])
			recorder.mic.peak = 0
			recorder.system.peak = 0
		}
		levels.resume()
		meter = levels
	} catch {
		fail("Could not start recording: \(error.localizedDescription). Allow your terminal under System Settings > Privacy & Security > Screen & System Audio Recording, and Microphone, then run again.")
	}
}

var stopping = false

func stop(reason: String? = nil) {
	DispatchQueue.main.async {
		guard !stopping else { return }
		stopping = true
		finish(reason: reason)
	}
}

func finish(reason: String?) {
	Task {
		meter?.cancel()
		try? await stream?.stopCapture()
		recorder.queue.sync {
			let system = recorder.system, mic = recorder.mic
			system.file = nil
			mic.file = nil
			var out: [String: Any] = ["type": "stopped"]
			if let reason { out["reason"] = reason }
			if let s = system.start { out["systemStart"] = s; out["systemFrames"] = system.frames }
			if let m = mic.start { out["micStart"] = m; out["micFrames"] = mic.frames }
			emit(out)
			if let data = try? JSONSerialization.data(withJSONObject: out) {
				try? data.write(to: dir.appendingPathComponent("capture.json"))
			}
		}
		exit(0)
	}
}

signal(SIGTERM, SIG_IGN)
let terminate = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
terminate.setEventHandler { stop() }
terminate.resume()

DispatchQueue.global().async {
	while let line = readLine() {
		if line.trimmingCharacters(in: .whitespaces) == "stop" { break }
	}
	stop()
}

dispatchMain()
