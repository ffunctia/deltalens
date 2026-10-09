import mupdf from "mupdf";

try {
  const doc = new mupdf.Document();
  doc.openDocument("sample.pdf");   // <-- put any PDF here

  console.log("Pages:", doc.countPages());

  const page = doc.loadPage(0);
  const mat = mupdf.Matrix.scale(2, 2);

  page.toPNG("./test_render.png", mat);

  console.log("Rendered test_render.png successfully!");

  page.destroy();
  doc.destroy();
} catch (err) {
  console.error("MuPDF FAILED:", err);
}
