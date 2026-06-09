declare module "html-to-text" {
	export function htmlToText(
		html: string,
		options?: {
			wordwrap?: false | number;
			selectors?: Array<{
				selector: string;
				format: string;
			}>;
		},
	): string;
}
