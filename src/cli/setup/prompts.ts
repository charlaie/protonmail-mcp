import * as prompts from "@clack/prompts";

export class SetupCancelled extends Error {
	constructor() {
		super("Setup cancelled. Unsaved changes were discarded.");
		this.name = "SetupCancelled";
	}
}

export function requireTerminal() {
	if (!process.stdin.isTTY || !process.stdout.isTTY)
		throw new Error(
			"Setup requires an interactive terminal. Run protonmail-mcp setup in your terminal. For automation, provide a versioned JSON configuration and policy file.",
		);
}

export function answer<T>(pending: Promise<T>): Promise<Exclude<T, symbol>>;
export async function answer(pending: Promise<unknown>): Promise<unknown> {
	const value = await pending;
	if (typeof value === "symbol") throw new SetupCancelled();
	return value;
}

export async function validatedText(
	message: string,
	initialValue: string,
	parse: (value: string) => unknown,
) {
	return answer(
		prompts.text({
			message,
			initialValue,
			validate(value) {
				try {
					parse(value ?? "");
				} catch (error) {
					return error instanceof Error ? error.message : "Invalid value.";
				}
			},
		}),
	);
}
