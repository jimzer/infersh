/**
 * Registers the composition for a video render.
 *
 * Staged into the render's temp directory beside the flattened composition
 * and the `config.json` the CLI writes; never imported by the CLI itself.
 * It imports Remotion, which is deliberately not a dependency of this repo
 * (ADR 13), so it is JavaScript: linted, but not typechecked here.
 *
 * Settings are layered, each overriding the last: built-in defaults, the
 * composition's `config` export, its `calculateMetadata` (which can size the
 * video from its props), then only the flags that were passed — so a flag
 * always wins and an unset flag never overrides the composition.
 */

import { Composition } from "remotion";
import Component, * as compositionModule from "./composition.tsx";
import overrides from "./config.json";

const DEFAULTS = { width: 1920, height: 1080, fps: 30, durationInFrames: 150 };

const fromComposition = compositionModule.config ?? Component.config ?? {};

const flags = overrides.dimensions;

const calculateMetadata = async (options) => {
	const computed = compositionModule.calculateMetadata
		? await compositionModule.calculateMetadata(options)
		: {};
	return { ...computed, ...flags };
};

export const Root = () => (
	<Composition
		id="main"
		component={Component}
		{...DEFAULTS}
		{...fromComposition}
		{...flags}
		defaultProps={overrides.props}
		calculateMetadata={calculateMetadata}
	/>
);
