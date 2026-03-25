#!/usr/bin/env bun

import * as bdProvider from "./providers/bd/index.ts";
import * as falProvider from "./providers/fal.ts";

const args = process.argv.slice(2);
const provider = args[0];

if (!provider || provider === "--help" || provider === "-h") {
	console.log("Usage: infer <provider> <command> [flags...]");
	console.log("       infer <provider> <command> json '<payload>'");
	console.log("");
	console.log("Providers:");
	console.log("  fal    fal.ai models (image gen, editing, etc.)");
	console.log("  bd     Brightdata web search, scraping & datasets");
	console.log("");
	console.log("Examples:");
	console.log(
		"  infer fal fal-ai/nano-banana/edit --prompt 'a cat' --image-urls http://...",
	);
	console.log('  infer bd search "pizza restaurants" --data-format markdown');
	console.log("  infer bd linkedin discover-jobs --location Paris");
	console.log(
		"  infer bd tiktok posts discover-by-keyword --search-keyword cooking",
	);
	process.exit(0);
}

switch (provider) {
	case "fal": {
		const model = args[1];
		const rest = args.slice(2);
		if (!model || model === "--help" || model === "-h") {
			console.error("Usage: infer fal <model> [flags...]");
			console.error(
				"       infer fal <model> --help  (show model flags from OpenAPI)",
			);
			process.exit(1);
		}
		await falProvider.run(model, rest);
		break;
	}
	case "bd":
		await bdProvider.run(args.slice(1));
		break;
	default:
		console.error(`Unknown provider: ${provider}`);
		console.error("Available providers: fal, bd");
		process.exit(1);
}
