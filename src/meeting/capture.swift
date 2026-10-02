// Records system audio and the microphone as two files, through
// ScreenCaptureKit (macOS 15+). Usage: capture <dir>
//
// Writes <dir>/system.caf and <dir>/mic.caf as it goes, so a crash keeps what
// was recorded. Prints one JSON line on stdout when recording starts, and one
// when it stops: on "stop", end of stdin, or SIGTERM. The stop line is also
// written to <dir>/capture.json, for transcribing later. SIGINT is ignored —
// the parent decides when to stop — so Ctrl-C cannot cut a file short.

import AVFoundation
import CoreMedia
import Foundation
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

final class Track {
	let url: URL
	var file: AVAudioFile?
	var start: Double?
	var frames: Int64 = 0
	init(_ url: URL) { self.url = url }

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
		guard status == noErr else { return }
		do {
			if file == nil {
				file = try AVAudioFile(
					forWriting: url, settings: format.settings,
					commonFormat: format.commonFormat, interleaved: format.isInterleaved)
				start = buffer.presentationTimeStamp.seconds
			}
			try file?.write(from: pcm)
			frames += Int64(count)
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
		fail("Recording stopped: \(error.localizedDescription)")
	}
}

let recorder = Recorder()
var stream: SCStream?

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
		emit(["type": "started"])
	} catch {
		fail("Could not start recording: \(error.localizedDescription). Allow your terminal under System Settings > Privacy & Security > Screen & System Audio Recording, and Microphone, then run again.")
	}
}

func stop() {
	Task {
		try? await stream?.stopCapture()
		recorder.queue.sync {
			let system = recorder.system, mic = recorder.mic
			system.file = nil
			mic.file = nil
			var out: [String: Any] = ["type": "stopped"]
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
