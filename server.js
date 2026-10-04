import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Client, handle_file } from "@gradio/client";

const app = express();

// Railway est derrière un proxy : req.protocol renverra https
app.set("trust proxy", 1);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;

const HF_TOKEN = process.env.HF_TOKEN;
const HF_SPACE = "zerogpu-aoti/wan2-2-fp8da-aoti-faster";
const DEBUG_API = Boolean(process.env.DEBUG_API);

// Une seule génération à la fois (évite d'épuiser le quota ZeroGPU)
let generating = false;

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
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const safeName = (file.originalname || "image.jpg").replace(
      /[^a-zA-Z0-9._-]/g,
      "_"
    );
    cb(
      null,
      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`
    );
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
});

/* =========================================================
   ROUTES DE BASE
========================================================= */

app.get("/", (_req, res) => {
  res.json({ success: true, message: "Cinema AI backend fonctionne." });
});

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
    console.log("=== UPLOAD IMAGE ===");
    console.log(
      "File:",
      req.file
        ? {
            originalname: req.file.originalname,
            mimetype: req.file.mimetype,
            size: req.file.size,
            filename: req.file.filename,
          }
        : null
    );

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Aucun fichier image reçu.",
      });
    }

    const baseUrl =
      process.env.PUBLIC_BACKEND_URL ||
      `${req.protocol}://${req.get("host")}`;

    const url = `${baseUrl}/uploads/${encodeURIComponent(req.file.filename)}`;

    const asset = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
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
    console.log("Personnages:", sceneData.characters?.length || 0);
    console.log("Lieux:", sceneData.locations?.length || 0);
    console.log("Mouvements:", sceneData.movements?.length || 0);
    console.log("Reference images:", sceneData.referenceImages?.length || 0);
    console.log("================================");

    res.json({
      success: true,
      message: "Données de scène reçues correctement.",
      received: {
        sceneId: sceneData.scene.id,
        characters: sceneData.characters?.length || 0,
        locations: sceneData.locations?.length || 0,
        movements: sceneData.movements?.length || 0,
        referenceImages: sceneData.referenceImages?.length || 0,
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

function firstImageUrl(images) {
  if (!Array.isArray(images) || images.length === 0) return null;
  const image = images[0];
  return image?.storageUrl || image?.url || null;
}

function findFirstImage(sceneData) {
  // 1. Image de référence de scène
  const sceneImage = firstImageUrl(sceneData.referenceImages);
  if (sceneImage) return sceneImage;

  // 2. Image du premier personnage qui en a une
  for (const character of sceneData.characters || []) {
    const url = firstImageUrl(character.imageReferences);
    if (url) return url;
  }

  // 3. Image du premier lieu qui en a une
  for (const location of sceneData.locations || []) {
    const url = firstImageUrl(location.imageReferences);
    if (url) return url;
  }

  return null;
}

/* =========================================================
   PROMPT CINÉMATIQUE
========================================================= */

function buildVideoPrompt(sceneData) {
  const scene = sceneData.scene || {};
  const parts = [];

  if (scene.title) parts.push(`Scene: ${scene.title}.`);
  if (scene.description) parts.push(scene.description);
  if (sceneData.action) parts.push(`Action: ${sceneData.action}`);

  if (Array.isArray(sceneData.characters)) {
    const names = sceneData.characters.map((c) => c.name).filter(Boolean);
    if (names.length > 0) {
      parts.push(`Characters present: ${names.join(", ")}.`);
    }
  }

  if (Array.isArray(sceneData.locations)) {
    const locations = sceneData.locations.map((l) => l.name).filter(Boolean);
    if (locations.length > 0) {
      parts.push(`Location: ${locations.join(", ")}.`);
    }
  }

  if (Array.isArray(sceneData.movements)) {
    const movements = sceneData.movements
      .map((movement) => {
        const text = movement.text || movement.name || "";
        const destination = movement.destination || "";
        return text && destination ? `${text} toward ${destination}` : text;
      })
      .filter(Boolean);

    if (movements.length > 0) {
      parts.push(`Movement: ${movements.join(". ")}.`);
    }
  }

  if (sceneData.dialogue) parts.push(`Dialogue: ${sceneData.dialogue}`);

  // visualStyle peut être un objet { text } ou une simple chaîne
  const styleText =
    typeof sceneData.visualStyle === "string"
      ? sceneData.visualStyle
      : sceneData.visualStyle?.text;

  if (styleText) parts.push(`Visual style: ${styleText}`);

  parts.push(
    "Cinematic realistic video, natural human movement, realistic facial expressions, subtle camera movement, realistic lighting, coherent environment."
  );

  return parts.join(" ");
}

/* =========================================================
   IMAGE -> ENTRÉE GRADIO
========================================================= */

function normalizeImageUrl(imageUrl) {
  if (!imageUrl) return null;

  if (imageUrl.startsWith("http://") || imageUrl.startsWith("https://")) {
    return imageUrl;
  }

  if (imageUrl.startsWith("/uploads/")) {
    return `${process.env.PUBLIC_BACKEND_URL || ""}${imageUrl}`;
  }

  return imageUrl;
}

// Si l'image est dans /uploads, on la lit sur le disque et on l'envoie
// directement au Space (plus fiable que de lui faire télécharger une URL).
async function loadImageInput(imageUrl) {
  try {
    const pathname = new URL(imageUrl, "http://localhost").pathname;

    if (pathname.startsWith("/uploads/")) {
      const file = path.join(
        uploadsDir,
        path.basename(decodeURIComponent(pathname))
      );

      if (fs.existsSync(file)) {
        const buffer = await fs.promises.readFile(file);
        const type = file.toLowerCase().endsWith(".png")
          ? "image/png"
          : "image/jpeg";

        console.log("Image lue depuis le disque:", file);
        return handle_file(new Blob([buffer], { type }));
      }
    }
  } catch (error) {
    console.warn("Lecture locale impossible, repli sur l'URL:", error.message);
  }

  return handle_file(imageUrl);
}

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/* =========================================================
   GÉNÉRATION VIDÉO WAN 2.2
========================================================= */

app.post("/api/generate-video", async (req, res) => {
  if (generating) {
    return res.status(429).json({
      success: false,
      message: "Une génération est déjà en cours. Réessaie dans un instant.",
    });
  }

  generating = true;

  try {
    console.log("======================================");
    console.log(" DEMANDE VIDEO WAN 2.2");
    console.log("======================================");

    if (!HF_TOKEN) {
      return res.status(500).json({
        success: false,
        message: "HF_TOKEN n'est pas configuré dans Railway.",
      });
    }

    const sceneData = req.body;

    if (!sceneData) {
      return res.status(400).json({
        success: false,
        message: "Aucune donnée reçue.",
      });
    }

    /* ---------- IMAGE ---------- */

    const imageUrl = normalizeImageUrl(
      sceneData.imageUrl || findFirstImage(sceneData)
    );

    if (!imageUrl) {
      return res.status(400).json({
        success: false,
        message: "Aucune image de départ trouvée pour la génération vidéo.",
      });
    }

    /* ---------- PROMPT ---------- */

    const prompt = sceneData.prompt || buildVideoPrompt(sceneData);

    /* ---------- PARAMÈTRES ---------- */

    // Wan 2.2 Fast est destiné aux clips courts
    const duration = Math.min(
      Math.max(
        toNumber(sceneData.duration ?? sceneData.scene?.duration, 5),
        1
      ),
      5
    );

    const steps = Math.min(
      Math.max(Math.round(toNumber(sceneData.steps, 6)), 1),
      20
    );

    const guidanceScale = toNumber(sceneData.guidanceScale, 1);
    const guidanceScale2 = toNumber(sceneData.guidanceScale2, 1);
    const seed = toNumber(sceneData.seed, 42);
    const randomizeSeed = sceneData.randomizeSeed !== false;

    const negativePrompt =
      sceneData.negativePrompt ||
      "blurry, distorted, low quality, deformed, unrealistic movement, extra limbs, duplicated person";

    console.log("Image:", imageUrl);
    console.log("Prompt:", prompt);
    console.log("Duration:", duration);
    console.log("Steps:", steps);

    /* ---------- CONNEXION GRADIO ---------- */

    console.log("Connexion à Hugging Face Space:", HF_SPACE);

    // Selon la version de @gradio/client, l'option s'appelle hf_token ou token
    const client = await Client.connect(HF_SPACE, {
      hf_token: HF_TOKEN,
      token: HF_TOKEN,
    });

    console.log("Connexion Hugging Face réussie.");

    if (DEBUG_API) {
      console.log("=== view_api ===");
      console.log(JSON.stringify(await client.view_api(), null, 2));
      console.log("================");
    }

    /* ---------- APPEL WAN 2.2 ---------- */

    console.log("Envoi de l'image au Space...");
    const image = await loadImageInput(imageUrl);
    console.log("Image prête, soumission du job...");

    const job = client.submit("/generate_video", [
      image,
      prompt,
      steps,
      negativePrompt,
      duration,
      guidanceScale,
      guidanceScale2,
      seed,
      randomizeSeed,
    ]);
    console.log("Job soumis, attente des statuts...");

    const startedAt = Date.now();
    const heartbeat = setInterval(() => {
      const s = Math.round((Date.now() - startedAt) / 1000);
      console.log(`... en attente du Space (${s}s)`);
    }, 15000);

    const timeout = setTimeout(() => {
      console.error("Timeout 8 min, annulation du job");
      job.cancel?.();
    }, 8 * 60 * 1000);

    let result = null;
    let lastStatus = null;

    try {
      for await (const msg of job) {
        if (msg.type === "status") {
          lastStatus = msg;
          console.log(
            "STATUS",
            msg.stage,
            msg.queue_position ?? "",
            msg.message ?? "",
            msg.code ?? ""
          );
        }

        if (msg.type === "data") {
          result = msg;
        }
      }
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
    }

    if (!result) {
      console.error("Aucun résultat. Dernier statut:", lastStatus);

      return res.status(502).json({
        success: false,
        message:
          lastStatus?.message ||
          "Le Space n'a renvoyé aucun résultat (quota ZeroGPU ou erreur du Space).",
        code: lastStatus?.code || null,
        stage: lastStatus?.stage || null,
      });
    }

    console.log("Réponse Wan 2.2 reçue.");
    console.log(result);

    /* ---------- RÉCUPÉRATION DE LA VIDÉO ---------- */

    const output = result?.data?.[0];

    if (!output) {
      return res.status(500).json({
        success: false,
        message: "Wan 2.2 n'a pas retourné de vidéo.",
        result,
      });
    }

    // Le composant vidéo peut renvoyer { video: { url } } ou { url } ou une chaîne
    const videoFile = output.video || output;

    let videoUrl = null;

    if (typeof videoFile === "string") {
      videoUrl = videoFile;
    } else if (videoFile?.url) {
      videoUrl = videoFile.url;
    } else if (videoFile?.path) {
      videoUrl = videoFile.path;
    }

    if (!videoUrl) {
      return res.status(500).json({
        success: false,
        message:
          "La vidéo a été générée mais son URL n'a pas pu être récupérée.",
        output,
      });
    }

    console.log("Video URL:", videoUrl);

    res.json({
      success: true,
      message: "Vidéo générée avec Wan 2.2.",
      video: { url: videoUrl },
      prompt,
      duration,
      steps,
    });
  } catch (error) {
    console.error("======================================");
    console.error("ERREUR GENERATION WAN 2.2");
    console.dir(error, { depth: 5 });
    console.error("======================================");

    res.status(500).json({
      success: false,
      message: "Erreur pendant la génération vidéo Wan 2.2.",
      error: error?.message || error?.title || String(error),
    });
  } finally {
    generating = false;
  }
});

/* =========================================================
   ERREUR MULTER / SERVEUR
========================================================= */

app.use((error, _req, res, _next) => {
  console.error("ERREUR SERVEUR:", error);

  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      success: false,
      message: "Erreur Multer lors de l'envoi du fichier.",
      error: error.message,
      code: error.code,
    });
  }

  return res.status(400).json({
    success: false,
    message: error.message || "Erreur serveur.",
  });
});

/* =========================================================
   START
========================================================= */

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Cinema AI backend démarré sur le port ${PORT}`);
  console.log(`Wan 2.2 configuré: ${Boolean(HF_TOKEN)}`);
});
