
import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Client } from "@gradio/client";

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;

const HF_TOKEN = process.env.HF_TOKEN;
const HF_SPACE = "zerogpu-aoti/wan2-2-fp8da-aoti-faster";

app.use(cors());
app.use(express.json({ limit: "10mb" }));

/* =========================================================
   DOSSIER UPLOADS
========================================================= */

const uploadsDir = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

app.use("/uploads", express.static(uploadsDir));

/* =========================================================
   MULTER
========================================================= */

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },

  filename: (_req, file, cb) => {
    const safeName = (file.originalname || "image.jpg").replace(
      /[^a-zA-Z0-9._-]/g,
      "_"
    );

    cb(
      null,
      `${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}-${safeName}`
    );
  },
});

const upload = multer({
  storage,

  limits: {
    fileSize: 20 * 1024 * 1024,
  },
});

/* =========================================================
   ROUTE PRINCIPALE
========================================================= */

app.get("/", (_req, res) => {
  res.json({
    success: true,
    message: "Cinema AI backend fonctionne.",
  });
});

/* =========================================================
   HEALTH
========================================================= */

app.get("/api/health", (_req, res) => {
  res.json({
    success: true,
    message: "Backend Cinema AI opérationnel.",
    wan22: {
      configured: Boolean(HF_TOKEN),
      space: HF_SPACE,
    },
  });
});

/* =========================================================
   UPLOAD IMAGE
========================================================= */

app.post("/api/assets", upload.single("image"), (req, res) => {
  try {
    console.log("=== TEST UPLOAD IMAGE ===");

    console.log("Content-Type:", req.headers["content-type"]);

    console.log(
      "File:",
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

    console.log("=========================");

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Aucun fichier image reçu.",
      });
    }

    const url = `${req.protocol}://${req.get("host")}/uploads/${encodeURIComponent(
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

      url,
    };

    res.json({
      success: true,

      message: "Image reçue correctement.",

      asset,
    });
  } catch (error) {
    console.error("Erreur /api/assets:", error);

    res.status(500).json({
      success: false,

      message: "Erreur pendant la réception de l'image.",

      error: error.message,
    });
  }
});

/* =========================================================
   RÉCEPTION DES DONNÉES DE SCÈNE
========================================================= */

app.post("/api/generate", (req, res) => {
  try {
    const sceneData = req.body;

    if (!sceneData || !sceneData.scene) {
      return res.status(400).json({
        success: false,
        message: "Données de scène manquantes.",
      });
    }

    console.log("=== DONNÉES DE SCÈNE REÇUES ===");

    console.log("Scene ID:", sceneData.scene.id);

    console.log(
      "Personnages:",
      sceneData.characters?.length || 0
    );

    console.log(
      "Lieux:",
      sceneData.locations?.length || 0
    );

    console.log(
      "Mouvements:",
      sceneData.movements?.length || 0
    );

    console.log(
      "Reference images:",
      sceneData.referenceImages?.length || 0
    );

    console.log("================================");

    res.json({
      success: true,

      message: "Données de scène reçues correctement.",

      received: {
        sceneId: sceneData.scene.id,

        characters: sceneData.characters?.length || 0,

        locations: sceneData.locations?.length || 0,

        movements: sceneData.movements?.length || 0,

        referenceImages:
          sceneData.referenceImages?.length || 0,
      },
    });
  } catch (error) {
    console.error("Erreur /api/generate:", error);

    res.status(500).json({
      success: false,

      message: "Erreur pendant le traitement de la scène.",

      error: error.message,
    });
  }
});

/* =========================================================
   UTILITAIRE : TROUVER UNE IMAGE
========================================================= */

function findFirstImage(sceneData) {
  // 1. Image de référence de scène
  if (
    Array.isArray(sceneData.referenceImages) &&
    sceneData.referenceImages.length > 0
  ) {
    return (
      sceneData.referenceImages[0]?.storageUrl ||
      sceneData.referenceImages[0]?.url ||
      null
    );
  }

  // 2. Image du premier personnage
  if (
    Array.isArray(sceneData.characters) &&
    sceneData.characters.length > 0
  ) {
    for (const character of sceneData.characters) {
      if (
        Array.isArray(character.imageReferences) &&
        character.imageReferences.length > 0
      ) {
        const image = character.imageReferences[0];

        return (
          image?.storageUrl ||
          image?.url ||
          null
        );
      }
    }
  }

  // 3. Image du premier lieu
  if (
    Array.isArray(sceneData.locations) &&
    sceneData.locations.length > 0
  ) {
    for (const location of sceneData.locations) {
      if (
        Array.isArray(location.imageReferences) &&
        location.imageReferences.length > 0
      ) {
        const image = location.imageReferences[0];

        return (
          image?.storageUrl ||
          image?.url ||
          null
        );
      }
    }
  }

  return null;
}

/* =========================================================
   CRÉER LE PROMPT CINÉMATIQUE
========================================================= */

function buildVideoPrompt(sceneData) {
  const scene = sceneData.scene || {};

  const parts = [];

  if (scene.title) {
    parts.push(`Scene: ${scene.title}.`);
  }

  if (scene.description) {
    parts.push(scene.description);
  }

  if (sceneData.action) {
    parts.push(`Action: ${sceneData.action}`);
  }

  if (Array.isArray(sceneData.characters)) {
    const names = sceneData.characters
      .map((character) => character.name)
      .filter(Boolean);

    if (names.length > 0) {
      parts.push(
        `Characters present: ${names.join(", ")}.`
      );
    }
  }

  if (Array.isArray(sceneData.locations)) {
    const locations = sceneData.locations
      .map((location) => location.name)
      .filter(Boolean);

    if (locations.length > 0) {
      parts.push(
        `Location: ${locations.join(", ")}.`
      );
    }
  }

  if (Array.isArray(sceneData.movements)) {
    const movements = sceneData.movements
      .map((movement) => {
        const text = movement.text || movement.name || "";
        const destination = movement.destination || "";

        if (text && destination) {
          return `${text} toward ${destination}`;
        }

        return text;
      })
      .filter(Boolean);

    if (movements.length > 0) {
      parts.push(
        `Movement: ${movements.join(". ")}.`
      );
    }
  }

  if (sceneData.dialogue) {
    parts.push(`Dialogue: ${sceneData.dialogue}`);
  }

  if (sceneData.visualStyle?.text) {
    parts.push(
      `Visual style: ${sceneData.visualStyle.text}`
    );
  }

  parts.push(
    "Cinematic realistic video, natural human movement, realistic facial expressions, subtle camera movement, realistic lighting, coherent environment."
  );

  return parts.join(" ");
}

/* =========================================================
   NORMALISER UNE IMAGE POUR HUGGING FACE
========================================================= */

function normalizeImageUrl(imageUrl) {
  if (!imageUrl) {
    return null;
  }

  // URL complète
  if (
    imageUrl.startsWith("http://") ||
    imageUrl.startsWith("https://")
  ) {
    return imageUrl;
  }

  // Chemin local /uploads/...
  if (imageUrl.startsWith("/uploads/")) {
    return `${process.env.PUBLIC_BACKEND_URL || ""}${imageUrl}`;
  }

  return imageUrl;
}

/* =========================================================
   GÉNÉRATION VIDÉO WAN 2.2
========================================================= */

app.post("/api/generate-video", async (req, res) => {
  try {
    console.log("======================================");
    console.log(" DEMANDE VIDEO WAN 2.2");
    console.log("======================================");

    if (!HF_TOKEN) {
      return res.status(500).json({
        success: false,

        message:
          "HF_TOKEN n'est pas configuré dans Railway.",
      });
    }

    const sceneData = req.body;

    if (!sceneData) {
      return res.status(400).json({
        success: false,

        message: "Aucune donnée reçue.",
      });
    }

    /* -----------------------------------------
       IMAGE
    ----------------------------------------- */

    let imageUrl =
      sceneData.imageUrl ||
      findFirstImage(sceneData);

    imageUrl = normalizeImageUrl(imageUrl);

    if (!imageUrl) {
      return res.status(400).json({
        success: false,

        message:
          "Aucune image de départ trouvée pour la génération vidéo.",
      });
    }

    /* -----------------------------------------
       PROMPT
    ----------------------------------------- */

    const prompt =
      sceneData.prompt ||
      buildVideoPrompt(sceneData);

    /* -----------------------------------------
       PARAMÈTRES WAN
    ----------------------------------------- */

    let duration = Number(
      sceneData.duration ||
        sceneData.scene?.duration ||
        5
    );

    if (!Number.isFinite(duration)) {
      duration = 5;
    }

    // Wan 2.2 Fast est destiné aux clips courts.
    duration = Math.min(
      Math.max(duration, 1),
      5
    );

    let steps = Number(
      sceneData.steps || 6
    );

    if (!Number.isFinite(steps)) {
      steps = 6;
    }

    steps = Math.min(
      Math.max(Math.round(steps), 1),
      20
    );

    let guidanceScale = Number(
      sceneData.guidanceScale ?? 1
    );

    if (!Number.isFinite(guidanceScale)) {
      guidanceScale = 1;
    }

    let guidanceScale2 = Number(
      sceneData.guidanceScale2 ?? 1
    );

    if (!Number.isFinite(guidanceScale2)) {
      guidanceScale2 = 1;
    }

    let seed = Number(
      sceneData.seed ?? 42
    );

    if (!Number.isFinite(seed)) {
      seed = 42;
    }

    const randomizeSeed =
      sceneData.randomizeSeed !== false;

    const negativePrompt =
      sceneData.negativePrompt ||
      "blurry, distorted, low quality, deformed, unrealistic movement, extra limbs, duplicated person";

    console.log("Image:", imageUrl);

    console.log("Prompt:", prompt);

    console.log("Duration:", duration);

    console.log("Steps:", steps);

    /* -----------------------------------------
       CONNEXION GRADIO
    ----------------------------------------- */

    console.log(
      "Connexion à Hugging Face Space:",
      HF_SPACE
    );

    const client = await Client.connect(
      HF_SPACE,
      {
        token: HF_TOKEN,
      }
    );

    console.log(
      "Connexion Hugging Face réussie."
    );

    /* -----------------------------------------
       APPEL WAN 2.2
    ----------------------------------------- */

    const result = await client.predict(
      "/generate_video",
      [
        imageUrl,
        prompt,
        steps,
        negativePrompt,
        duration,
        guidanceScale,
        guidanceScale2,
        seed,
        randomizeSeed,
      ]
    );

    console.log(
      "Réponse Wan 2.2 reçue."
    );

    console.log(result);

    /* -----------------------------------------
       RÉCUPÉRATION DU VIDEO
    ----------------------------------------- */

    const output =
      result?.data?.[0];

    if (!output) {
      return res.status(500).json({
        success: false,

        message:
          "Wan 2.2 n'a pas retourné de vidéo.",

        result,
      });
    }

    let videoUrl = null;

    if (typeof output === "string") {
      videoUrl = output;
    } else if (output.url) {
      videoUrl = output.url;
    } else if (output.path) {
      videoUrl = output.path;
    }

    if (!videoUrl) {
      return res.status(500).json({
        success: false,

        message:
          "La vidéo a été générée mais son URL n'a pas pu être récupérée.",

        output,
      });
    }

    console.log(
      "Video URL:",
      videoUrl
    );

    /* -----------------------------------------
       RÉPONSE FRONTEND
    ----------------------------------------- */

    res.json({
      success: true,

      message:
        "Vidéo générée avec Wan 2.2.",

      video: {
        url: videoUrl,
      },

      prompt,

      duration,

      steps,
    });
  } catch (error) {
    console.error(
      "======================================"
    );

    console.error(
      "ERREUR GENERATION WAN 2.2"
    );

    console.error(error);

    console.error(
      "======================================"
    );

    res.status(500).json({
      success: false,

      message:
        "Erreur pendant la génération vidéo Wan 2.2.",

      error:
        error?.message ||
        String(error),
    });
  }
});

/* =========================================================
   ERREUR MULTER / SERVEUR
========================================================= */

app.use(
  (error, _req, res, _next) => {
    console.error(
      "ERREUR SERVEUR:",
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

    return res.status(400).json({
      success: false,

      message:
        error.message ||
        "Erreur serveur.",
    });
  }
);

/* =========================================================
   START
========================================================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Cinema AI backend démarré sur le port ${PORT}`
    );

    console.log(
      `Wan 2.2 configuré: ${Boolean(HF_TOKEN)}`
    );
  }
);

