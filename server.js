
import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==========================
// CONFIGURATION
// ==========================

app.use(cors());

app.use(
  express.json({
    limit: "10mb",
  })
);

// ==========================
// DOSSIER DES ASSETS
// ==========================

const uploadsDir = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, {
    recursive: true,
  });
}

// ==========================
// MULTER
// ==========================

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },

  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(
      /[^a-zA-Z0-9._-]/g,
      "_"
    );

    const uniqueName = `${Date.now()}-${safeName}`;

    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,

  limits: {
    fileSize: 20 * 1024 * 1024,
  },

  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Seules les images sont acceptées."));
    }
  },
});

// ==========================
// FICHIERS STATIQUES
// ==========================

app.use(
  "/uploads",
  express.static(uploadsDir)
);

// ==========================
// ROUTE PRINCIPALE
// ==========================

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Cinema AI backend fonctionne.",
  });
});

// ==========================
// TEST BACKEND
// ==========================

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "Backend Cinema AI opérationnel.",
  });
});

// ==========================
// UPLOAD D'UNE OU PLUSIEURS IMAGES
// ==========================

app.post(
  "/api/assets",
  upload.array("images", 20),
  (req, res) => {
    try {
      const files = req.files || [];

      const assets = files.map((file) => {
        const publicUrl =
          `${req.protocol}://${req.get("host")}` +
          `/uploads/${encodeURIComponent(file.filename)}`;

        return {
          id: `${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 10)}`,

          name: file.originalname,

          filename: file.filename,

          mimetype: file.mimetype,

          size: file.size,

          url: publicUrl,
        };
      });

      console.log(
        `Assets reçus : ${assets.length}`
      );

      console.log(assets);

      res.json({
        success: true,

        message:
          "Images reçues correctement.",

        assets,
      });
    } catch (error) {
      console.error(
        "Erreur /api/assets :",
        error
      );

      res.status(500).json({
        success: false,

        message:
          "Erreur pendant la réception des images.",

        error: error.message,
      });
    }
  }
);

// ==========================
// RÉCEPTION DES DONNÉES DE SCÈNE
// ==========================

app.post("/api/generate", (req, res) => {
  try {
    const sceneData = req.body;

    if (
      !sceneData ||
      !sceneData.scene
    ) {
      return res.status(400).json({
        success: false,

        message:
          "Données de scène manquantes.",
      });
    }

    console.log(
      "================================="
    );

    console.log(
      "NOUVELLE DEMANDE DE GÉNÉRATION"
    );

    console.log(
      "Scene ID :",
      sceneData.scene.id
    );

    console.log(
      "Personnages :",
      sceneData.characters?.length || 0
    );

    console.log(
      "Lieux :",
      sceneData.locations?.length || 0
    );

    console.log(
      "Mouvements :",
      sceneData.movements?.length || 0
    );

    console.log(
      "Images générales :",
      sceneData.referenceImages?.length || 0
    );

    console.log(
      "================================="
    );

    res.json({
      success: true,

      message:
        "Données de scène reçues correctement.",

      received: {
        sceneId: sceneData.scene.id,

        characters:
          sceneData.characters?.length || 0,

        locations:
          sceneData.locations?.length || 0,

        movements:
          sceneData.movements?.length || 0,

        referenceImages:
          sceneData.referenceImages?.length || 0,
      },
    });
  } catch (error) {
    console.error(
      "Erreur /api/generate :",
      error
    );

    res.status(500).json({
      success: false,

      message:
        "Erreur pendant le traitement de la scène.",

      error: error.message,
    });
  }
});

// ==========================
// GESTION DES ERREURS MULTER
// ==========================

app.use(
  (error, req, res, next) => {
    if (error instanceof multer.MulterError) {
      return res.status(400).json({
        success: false,

        message:
          "Erreur lors de l'envoi du fichier.",

        error: error.message,
      });
    }

    if (error) {
      return res.status(400).json({
        success: false,

        message:
          error.message ||
          "Erreur serveur.",
      });
    }

    next();
  }
);

// ==========================
// DÉMARRAGE
// ==========================

const PORT =
  process.env.PORT || 3000;

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Cinema AI backend démarré sur le port ${PORT}`
    );
  }
);
