/**
 * Embedding things inside an HTML document safely.
 *
 * Both helpers exist because the HTML parser ends a `<script>` element at the
 * first `</script`, wherever it appears — including inside a JavaScript
 * string or a JSON value.
 */

/**
 * Escapes a JSON string for embedding in a `<script>` element.
 *
 * Escaping every `<` is blunt but total, and survives a round trip because
 * `<` is ordinary JSON.
 */
export const escapeForScript = (json: string): string =>
	json.replace(/</g, "\\u003c");

/**
 * Wraps JavaScript in a `<script>` element that cannot be closed early.
 *
 * `<\/script` means the same thing to JavaScript in every place that sequence
 * can legally appear, so the rewrite is safe. The original case is kept:
 * rewriting `</SCRIPT` to lowercase would change the value of a string that
 * contains it.
 */
export const inlineScript = (code: string): string =>
	`<script>${code.replace(/<\/(script)/gi, "<\\/$1")}</script>`;

/** Escapes text for an element's content, such as `<title>`. */
export const escapeText = (text: string): string =>
	text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
