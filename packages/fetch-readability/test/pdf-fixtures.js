/**
 * Hand-built minimal PDFs for tests (no PDF library needed). Offsets in the
 * xref table are computed exactly so pdf.js needs no recovery pass.
 */

/**
 * Escape a string for a PDF literal `( ... )`.
 * @param {string} s
 */
function pdfLiteral(s) {
	return s.replace(/[\\()]/gu, (m) => `\\${m}`);
}

/**
 * Build a one-or-more-page PDF whose pages each draw the given lines of text
 * with Helvetica (standard 14 font, so no font embedding is needed).
 *
 * @param {string[][]} pages  per page, the lines to draw (top to bottom).
 * @param {{ title?: string }} [options]
 * @returns {Uint8Array}
 */
export function makePdf(pages, options = {}) {
	/** @type {string[]} object bodies, index = object number - 1 */
	const objects = [];
	const add = (body) => { objects.push(body); return objects.length; };

	const catalogNum = add("<< /Type /Catalog /Pages 2 0 R >>");
	const pagesNum = add("PLACEHOLDER");
	const fontNum = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
	const pageNums = [];
	for (const lines of pages) {
		let stream = "BT /F1 12 Tf 72 720 Td 14 TL\n";
		for (const line of lines) stream += `(${pdfLiteral(line)}) Tj T*\n`;
		stream += "ET";
		const contentNum = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
		const pageNum = add(`<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNum} 0 R >>`);
		pageNums.push(pageNum);
	}
	objects[pagesNum - 1] = `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageNums.length} >>`;
	let infoNum;
	if (options.title !== undefined) infoNum = add(`<< /Title (${pdfLiteral(options.title)}) >>`);

	let out = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
	const offsets = [];
	objects.forEach((body, i) => {
		offsets.push(Buffer.byteLength(out, "latin1"));
		out += `${i + 1} 0 obj\n${body}\nendobj\n`;
	});
	const xrefOffset = Buffer.byteLength(out, "latin1");
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
	out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNum} 0 R${infoNum ? ` /Info ${infoNum} 0 R` : ""} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
	return new Uint8Array(Buffer.from(out, "latin1"));
}

export const HELLO_PDF = makePdf([["Hello PDF", "Second line here"]], { title: "Hello Title" });
export const TWO_PAGE_PDF = makePdf([["Page one text"], ["Page two text"]]);
