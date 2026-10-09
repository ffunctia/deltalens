import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import fsSync from "fs";
import os from "os";
import { execFile } from "child_process";
import multer from "multer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const supportedFormats = [".pdf", ".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp", ".csv", ".txt"];

const upload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      const uploadDir = path.join(__dirname, "tmp", "uploads");
      await fs.mkdir(uploadDir, { recursive: true });
      cb(null, uploadDir);
    },
    filename: (_req, file, cb) => {
      const safeName = (file.originalname || "upload").replace(/[^a-zA-Z0-9_.-]/g, "_");
      cb(null, `${Date.now()}-${safeName}`);
    }
  }),
  limits: {
    fileSize: 50 * 1024 * 1024
  }
});

async function findLibreOfficeBinary() {
  const candidates = ["soffice", "libreoffice"];
  for (const binary of candidates) {
    try {
      const { stdout } = await new Promise((resolve, reject) => {
        execFile("which", [binary], { timeout: 12000 }, (error, stdout) => {
          if (error) return reject(error);
          resolve({ stdout });
        });
      });

      if (stdout && stdout.trim()) {
        return stdout.trim().split(/\n/)[0];
      }
    } catch {
      // Ignore missing binaries and continue checking.
    }
  }

  return null;
}

async function convertToPdf(filePath, originalName) {
  const libreOffice = await findLibreOfficeBinary();
  if (!libreOffice) {
    throw new Error("LibreOffice is not installed or not on PATH. Install LibreOffice with headless support to convert DOCX/XLSX/PPTX/ODT files before comparing them.");
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "doculens-"));
  const outputDir = path.join(tempDir, "converted");
  await fs.mkdir(outputDir, { recursive: true });

  await new Promise((resolve, reject) => {
    execFile(
      libreOffice,
      ["--headless", "--convert-to", "pdf", "--outdir", outputDir, filePath],
      { timeout: 180000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || stdout || error.message));
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });

  const outputFiles = await fs.readdir(outputDir);
  const pdfFile = outputFiles.find((file) => file.toLowerCase().endsWith(".pdf"));

  if (!pdfFile) {
    throw new Error(`Document conversion succeeded but no PDF was created for ${originalName}.`);
  }

  const pdfPath = path.join(outputDir, pdfFile);
  const pdfBuffer = await fs.readFile(pdfPath);
  await fs.rm(tempDir, { recursive: true, force: true });

  return {
    fileName: pdfFile,
    buffer: pdfBuffer,
    mimeType: "application/pdf"
  };
}

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public"), { index: false }));
app.use("/src", express.static(path.join(__dirname, "src")));

app.get("/api/system-status", async (_req, res) => {
  const libreOffice = await findLibreOfficeBinary();
  res.json({
    webOnly: true,
    libreOfficeInstalled: Boolean(libreOffice),
    supportedFormats,
    conversionReady: Boolean(libreOffice),
    aiProviderOptions: ["openai", "gemini"]
  });
});

app.post("/api/convert", upload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: "No document file was uploaded." });
  }

  const extension = path.extname(file.originalname || "").toLowerCase();
  if (extension === ".pdf") {
    const pdfBuffer = await fs.readFile(file.path);
    return res
      .setHeader("Content-Type", "application/pdf")
      .setHeader("Content-Disposition", `attachment; filename="${path.basename(file.originalname)}"`)
      .send(pdfBuffer);
  }

  if (!supportedFormats.includes(extension)) {
    return res.status(400).json({
      error: `Unsupported file type: ${extension}. Supported formats: ${supportedFormats.join(", ")}.`
    });
  }

  try {
    const converted = await convertToPdf(file.path, file.originalname || "uploaded-document");
    return res
      .setHeader("Content-Type", "application/pdf")
      .setHeader("Content-Disposition", `attachment; filename="${converted.fileName}"`)
      .send(converted.buffer);
  } catch (error) {
    console.error("Document conversion failed:", error);
    return res.status(500).json({
      error: error.message || "Conversion failed. Check that LibreOffice is installed and available on PATH."
    });
  }
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "doculens.html"));
});

app.get("/doculens", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "doculens.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log("DocuLens web app is ready at /doculens");
});
