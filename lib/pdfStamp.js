"use strict";

const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

// Stamps the response token in the page footer so a PDF returned by email or
// mail can always be matched back to a recipient by eye, even off a template
// SendNewsletters has never seen before. The template's own form fields are left
// blank on purpose -- guessing which contact field belongs in which form field
// put wrong answers on people's forms -- so the recipient fills in everything.
async function stampToken(templateBytes, token) {
  const pdfDoc = await PDFDocument.load(templateBytes);

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const firstPage = pdfDoc.getPages()[0];
  if (firstPage) {
    const { width } = firstPage.getSize();
    firstPage.drawText(`Ref: ${token}`, {
      x: width - 110,
      y: 14,
      size: 8,
      font,
      color: rgb(0.45, 0.45, 0.45),
    });
  }

  return pdfDoc.save();
}

module.exports = { stampToken };
