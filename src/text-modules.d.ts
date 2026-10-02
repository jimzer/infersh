// Source files embedded as text (`with { type: "text" }`) that TypeScript
// cannot load as modules itself.
declare module "*.swift" {
	const source: string;
	export default source;
}
