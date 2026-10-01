
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const uploadsDir = path.join(__dirname, "uploads");

fs.mkdirSync(uploadsDir, { recursive: true });

app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use("/uploads", express.static(uploadsDir));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    const name = path.basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9_-]/g, "_") || "image";
    cb(null, `${Date.now()}-${name}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }
});

app.get("/", (_req, res) => {
  res.json({ success: true, message: "Cinema AI backend actif." });
});

app.post("/api/assets", upload.single("image"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Aucune image reçue."
      });
    }

    const url =
      `${req.protocol}://${req.get("host")}/uploads/` +
      encodeURIComponent(req.file.filename);

    res.json({
      success: true,
      asset: {
        id: Date.now(),
        name: req.file.originalname,
        url,
        storageUrl: url,
        ownerType: req.body.ownerType || null,
        ownerId: req.body.ownerId || null,
        referenceId: req.body.referenceId || null
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.post("/api/generate", (req, res) => {
  const data = req.body || {};
  const characters = Array.isArray(data.characters) ? data.characters : [];
  const locations = Array.isArray(data.locations) ? data.locations : [];
  const movements = Array.isArray(data.movements) ? data.movements : [];

  const images = [];

  for (const c of characters) {
    for (const image of c.imageReferences || []) {
      images.push(image.url || "");
    }
  }

  for (const l of locations) {
    for (const image of l.imageReferences || []) {
      images.push(image.url || "");
    }
  }

  for (const image of data.referenceImages || []) {
    images.push(image.url || "");
  }

  res.json({
    success: true,
    message: "Données de scène reçues correctement.",
    received: {
      sceneId: data.scene?.id || null,
      characters: characters.length,
      locations: locations.length,
      movements: movements.length,
      referenceImages: Array.isArray(data.referenceImages)
        ? data.referenceImages.length
        : 0,
      totalImages: images.length,
      serverImages: images.filter(url => url.includes("/uploads/")).length,
      blobImages: images.filter(url => url.startsWith("blob:")).length
    }
  });
});

app.listen(PORT, () => {
  console.log(`Cinema AI backend démarré sur le port ${PORT}`);
});
