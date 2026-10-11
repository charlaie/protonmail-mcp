import { MAX_ATTACHMENT_CHARACTERS } from "./limits.js";

/** Every separator and text item consumes the same output budget. */
export function createTextBudget() {
	let text = "";
	let truncated = false;
	return {
		append(value: string) {
			const remaining = MAX_ATTACHMENT_CHARACTERS - text.length;
			text += value.slice(0, remaining);
			truncated ||= value.length >= remaining;
			return text.length === MAX_ATTACHMENT_CHARACTERS;
		},
		result() {
			return { text, truncated };
		},
	};
}
