
import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const app = express();

// ==================================================
// CONFIGURATION
// ==================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;

app.use(cors());

app.use(
  express.json({
    limit: "10mb",
  })
);

// ==================================================
// DOSSIER UPLOADS
// ==================================================

const uploadsDir = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, {
    recursive: true,
  });
}

// ==================================================
// MULTER
// ==================================================

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },

  filename: (req, file, cb) => {
    const originalName = file.originalname || "image";

    const safeName = originalName.replace(
      /[^a-zA-Z0-9._-]/g,
      "_"
    );

    const uniqueName =
      `${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}-${safeName}`;

    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,

  limits: {
    fileSize: 20 * 1024 * 1024,
  },
});

// ==================================================
// FICHIERS STATIQUES
// ==================================================

app.use(
  "/uploads",
  express.static(uploadsDir)
);

// ==================================================
// TEST RACINE
// ==================================================

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Cinema AI backend fonctionne.",
  });
});

// ==================================================
// HEALTH CHECK
// ==================================================

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "Backend Cinema AI opérationnel.",
  });
});

// ==================================================
// TEST UPLOAD IMAGE
// ==================================================

app.post(
  "/api/assets",
  upload.single("image"),
  (req, res) => {
    try {
      console.log(
        "================================="
      );

      console.log(
        "TEST UPLOAD IMAGE"
      );

      console.log(
        "Headers Content-Type :",
        req.headers["content-type"]
      );

      console.log(
        "Fichier reçu :",
        req.file
          ? {
              fieldname: req.file.fieldname,
              originalname: req.file.originalname,
              mimetype: req.file.mimetype,
              size: req.file.size,
              filename: req.file.filename,
            }
          : null
      );

      console.log(
        "================================="
      );

      // Aucun fichier reçu
      if (!req.file) {
        return res.status(400).json({
          success: false,

          message:
            "Aucun fichier image reçu.",

          debug: {
            contentType:
              req.headers["content-type"] || null,
          },
        });
      }

      const fileUrl =
        `${req.protocol}://${req.get("host")}` +
        `/uploads/${encodeURIComponent(
          req.file.filename
        )}`;

      const asset = {
        id: `${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 10)}`,

        name: req.file.originalname,

        filename: req.file.filename,

        mimetype: req.file.mimetype,

        size: req.file.size,

        url: fileUrl,
      };

      console.log(
        "URL image :",
        fileUrl
      );

      res.json({
        success: true,

        message:
          "Image reçue correctement.",

        asset,
      });
    } catch (error) {
      console.error(
        "Erreur /api/assets :",
        error
      );

      res.status(500).json({
        success: false,

        message:
          "Erreur pendant la réception de l'image.",

        error: error.message,
      });
    }
  }
);

// ==================================================
// RÉCEPTION DES DONNÉES DE SCÈNE
// ==================================================

app.post(
  "/api/generate",
  (req, res) => {
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
        "DONNÉES DE SCÈNE REÇUES"
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
        "Reference images :",
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
          sceneId:
            sceneData.scene.id,

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
  }
);

// ==================================================
// ERREURS MULTER
// ==================================================

app.use(
  (error, req, res, next) => {
    console.error(
      "ERREUR SERVEUR :",
      error
    );

    if (
      error instanceof multer.MulterError
    ) {
      return res.status(400).json({
        success: false,

        message:
          "Erreur Multer lors de l'envoi du fichier.",

        error: error.message,

        code: error.code,
      });
    }

    if (error) {
      return res.status(400).json({
        success: false,

        message:
          "Erreur lors de l'envoi du fichier.",

        error:
          error.message ||
          "Erreur inconnue.",
      });
    }

    next();
  }
);

// ==================================================
// DÉMARRAGE
// ==================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Cinema AI backend démarré sur le port ${PORT}`
    );

    console.log(
      `Port utilisé : ${PORT}`
    );
  }
);







