import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@gradio/client";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HF_TOKEN = process.env.HF_TOKEN;
const HF_SPACE =
  process.env.HF_SPACE || "zerogpu-aoti/wan2-2-fp8da-aoti-faster";
const WAN_TIMEOUT_MS = 8 * 60 * 1000;
const MAX_UPLOAD_SIZE = 500 * 1024 * 1024;

const uploadsDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

// Railway sits behind a proxy; trust its forwarded protocol/host headers so
// uploaded-file URLs use the public HTTPS address.
app.set("trust proxy", 1);

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use("/uploads", express.static(uploadsDir));

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, uploadsDir),
  filename: (_req, file, callback) => {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "-");
    callback(null, `${timestamp}-${random}-${safeName}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_UPLOAD_SIZE,
  },
});

function formatEta(eta) {
  if (eta === null || eta === undefined || !Number.isFinite(Number(eta))) {
    return "?";
  }

  const seconds = Number(eta);
  return seconds < 60
    ? `${Math.round(seconds)}s`
    : `${Math.round(seconds / 60)}min`;
}

function extractVideoValue(data) {
  if (!data) return null;

  if (Array.isArray(data)) {
    for (const item of data) {
      const result = extractVideoValue(item);
      if (result) return result;
    }
    return null;
  }

  if (typeof data === "string") {
    return data.startsWith("http://") || data.startsWith("https://")
      ? data
      : null;
  }

  if (typeof data === "object") {
    for (const key of ["video", "url", "path", "file", "value"]) {
      if (data[key] !== undefined && data[key] !== null) {
        const result = extractVideoValue(data[key]);
        if (result) return result;
      }
    }
  }

  return null;
}

function normalizeImageUrl(imageUrl) {
  if (!imageUrl || typeof imageUrl !== "string") return null;
  if (/^https?:\/\//i.test(imageUrl)) return imageUrl;
  if (imageUrl.startsWith("/uploads/")) return imageUrl;
  if (imageUrl.startsWith("uploads/")) return `/${imageUrl}`;
  return imageUrl;
}

function findFirstImage(sceneData) {
  if (!sceneData || typeof sceneData !== "object") return null;

  if (sceneData.imageUrl) return normalizeImageUrl(sceneData.imageUrl);
  if (sceneData.image) return normalizeImageUrl(sceneData.image);

  const referenceUrl = (image) => {
    if (typeof image === "string") return normalizeImageUrl(image);
    if (!image || typeof image !== "object") return null;
    return normalizeImageUrl(image.storageUrl || image.url);
  };

  for (const group of [sceneData.characters, sceneData.locations]) {
    if (!Array.isArray(group)) continue;
    for (const item of group) {
      if (!item) continue;
      if (Array.isArray(item.imageReferences)) {
        for (const image of item.imageReferences) {
          const url = referenceUrl(image);
          if (url) return url;
        }
      }
      const directUrl = normalizeImageUrl(item.imageUrl || item.image);
      if (directUrl) return directUrl;
    }
  }

  for (const image of sceneData.referenceImages || []) {
    const url = referenceUrl(image);
    if (url) return url;
  }

  for (const image of sceneData.visualStyle?.images || []) {
    const url = referenceUrl(image);
    if (url) return url;
  }

  return null;
}

function buildVideoPrompt(sceneData) {
  if (!sceneData || typeof sceneData !== "object") {
    return "Create a cinematic realistic video.";
  }

  const parts = [];

  if (sceneData.description) {
    parts.push(`Scene description: ${sceneData.description}`);
  }
  if (sceneData.action) {
    parts.push(`Action and staging: ${sceneData.action}`);
  }

  if (Array.isArray(sceneData.characters)) {
    const characters = sceneData.characters
      .filter(Boolean)
      .map((character) => {
        const name = character.name || "character";
        return character.description
          ? `${name}: ${character.description}`
          : name;
      })
      .join(", ");
    if (characters) parts.push(`Characters: ${characters}`);
  }

  if (Array.isArray(sceneData.locations)) {
    const locations = sceneData.locations
      .filter(Boolean)
      .map(
        (location) =>
          location.name ||
          location.title ||
          location.description ||
          "",
      )
      .filter(Boolean)
      .join(", ");
    if (locations) parts.push(`Locations: ${locations}`);
  }

  if (Array.isArray(sceneData.movements)) {
    const movements = sceneData.movements
      .filter(Boolean)
      .map((movement) => {
        const action =
          movement.action ||
          movement.name ||
          movement.description ||
          "";
        const destination = movement.destination
          ? ` toward ${movement.destination}`
          : "";
        return `${action}${destination}`;
      })
      .filter(Boolean)
      .join(". ");
    if (movements) parts.push(`Movement sequence: ${movements}`);
  }

  if (sceneData.dialogue) {
    parts.push(`Dialogue: ${sceneData.dialogue}`);
  }

  if (sceneData.visualStyle) {
    const style =
      typeof sceneData.visualStyle === "string"
        ? sceneData.visualStyle
        : sceneData.visualStyle.text || "";
    if (style) parts.push(`Visual style: ${style}`);
  }

  parts.push(
    "Cinematic realistic video, natural human movement, realistic facial expressions, realistic body proportions, coherent environment, cinematic lighting, subtle camera movement, consistent characters and locations, high visual quality.",
  );

  return parts.join("\n\n");
}

function resolveLocalUploadPath(imageUrl) {
  const relativePath = imageUrl.replace(/^\/+/, "");
  const resolvedPath = path.resolve(__dirname, relativePath);
  const resolvedUploadsDir = `${path.resolve(uploadsDir)}${path.sep}`;

  if (
    resolvedPath !== path.resolve(uploadsDir) &&
    !resolvedPath.startsWith(resolvedUploadsDir)
  ) {
    throw new Error("Le chemin de l’image n’est pas autorisé.");
  }

  return resolvedPath;
}

app.post(
  "/api/assets",
  upload.fields([
    {
      name: "image",
      maxCount: 1,
    },
    {
      name: "file",
      maxCount: 1,
    },
  ]),
  (req, res) => {
    try {
      /*
       * Le frontend Cinema AI envoie actuellement :
       *
       * formData.append("image", blob, filename)
       *
       * Mais on accepte aussi "file" pour éviter
       * les problèmes de compatibilité.
       */
      const uploadedFile =
        req.files?.image?.[0] ||
        req.files?.file?.[0];

      if (!uploadedFile) {
        console.error("Aucun fichier reçu dans /api/assets.");
        console.error("Champs reçus:", Object.keys(req.body || {}));

        return res.status(400).json({
          success: false,
          message: "Aucun fichier image reçu.",
        });
      }

      const publicUrl =
        `${req.protocol}://${req.get("host")}/uploads/${encodeURIComponent(
          uploadedFile.filename,
        )}`;

      console.log("==========================================");
      console.log("ASSET UPLOADÉ");
      console.log("Nom:", uploadedFile.originalname);
      console.log("Fichier:", uploadedFile.filename);
      console.log("Taille:", uploadedFile.size);
      console.log("URL:", publicUrl);
      console.log("==========================================");

      return res.json({
        success: true,
        message: "Image reçue correctement.",
        asset: {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          name: uploadedFile.originalname,
          filename: uploadedFile.filename,
          mimetype: uploadedFile.mimetype,
          size: uploadedFile.size,
          url: publicUrl,
          storageUrl: publicUrl,
          uploaded: true,
        },
      });
    } catch (error) {
      console.error("Erreur /api/assets:");
      console.error(error);

      return res.status(500).json({
        success: false,
        message: error?.message || "Erreur serveur pendant l'upload.",
      });
    }
  },
);

app.get("/", (_req, res) => {
  res.json({
    success: true,
    service: "Cinema AI Backend",
    status: "online",
    wanSpace: HF_SPACE,
    wanTimeoutMinutes: WAN_TIMEOUT_MS / 60000,
  });
});

app.get("/api/health", (_req, res) => {
  res.json({
    success: true,
    status: "ok",
    hfConfigured: Boolean(HF_TOKEN),
    wanSpace: HF_SPACE,
  });
});

app.get("/api/test-huggingface", async (_req, res) => {
  try {
    if (!HF_TOKEN) {
      return res.status(500).json({
        success: false,
        error: "HF_TOKEN n'est pas configuré dans l'environnement.",
      });
    }

    await Client.connect(HF_SPACE, {
      token: HF_TOKEN,
      events: ["data", "status"],
    });

    return res.json({
      success: true,
      message: "Connexion Hugging Face réussie.",
      space: HF_SPACE,
    });
  } catch (error) {
    console.error("Erreur Hugging Face:", error);
    return res.status(500).json({
      success: false,
      error:
        error?.message ||
        "Impossible de se connecter à Hugging Face.",
    });
  }
});

async function waitForWanJob(job) {
  const startedAt = Date.now();

  // IMPORTANT : on n'utilise PAS "for await ... return" car un return dans la
  // boucle appelle job.return() du client Gradio, qui peut rester bloqué
  // indéfiniment après "complete". On lit l'itérateur à la main et on
  // résout la promesse dès que la vidéo est disponible.
  return new Promise((resolve, reject) => {
    let settled = false;
    let finalVideo = null;
    let lastStatus = null;
    let dataReceived = false;
    let graceTimer = null;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(graceTimer);
      fn(value);
    };

    const timeoutTimer = setTimeout(() => {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      console.error(`Timeout Wan 2.2 après ${elapsed}s.`);
      try {
        if (typeof job?.cancel === "function") {
          Promise.resolve(job.cancel()).catch(() => {});
        }
      } catch {}
      finish(
        reject,
        new Error(
          `Le Space Wan 2.2 n'a pas terminé après ${Math.round(
            WAN_TIMEOUT_MS / 60000,
          )} minutes. Le job a été annulé.`,
        ),
      );
    }, WAN_TIMEOUT_MS);

    const iterator = job[Symbol.asyncIterator]
      ? job[Symbol.asyncIterator]()
      : job;

    (async () => {
      try {
        while (!settled) {
          const { value: message, done } = await iterator.next();
          if (done) break;
          if (!message) continue;

          if (message.type === "status") {
            lastStatus = message;
            const stage = message.stage || message.status || "unknown";
            const elapsed = Math.round((Date.now() - startedAt) / 1000);
            console.log(
              `[WAN STATUS] stage=${stage} | position=${message.position ?? "?"} | queue=${message.size ?? message.queue_size ?? "?"} | ETA=${formatEta(message.eta)} | elapsed=${elapsed}s`,
            );

            if (stage === "error") {
              return finish(
                reject,
                new Error(
                  message.message ||
                    message.code ||
                    "Le Space Wan 2.2 a signalé une erreur.",
                ),
              );
            }

            if (stage === "complete") {
              if (finalVideo) {
                console.log("[WAN] Résultat complet reçu.");
                return finish(resolve, { video: finalVideo, status: message });
              }
              // Laisser 15 s au dernier événement "data" pour arriver.
              graceTimer = setTimeout(() => {
                if (finalVideo) {
                  finish(resolve, { video: finalVideo, status: lastStatus });
                } else {
                  finish(
                    reject,
                    new Error(
                      dataReceived
                        ? "Wan 2.2 a terminé, mais la donnée reçue ne contient pas d’URL vidéo exploitable."
                        : "Wan 2.2 a terminé sans renvoyer de vidéo.",
                    ),
                  );
                }
              }, 15000);
            }
          }

          if (message.type === "data") {
            console.log("[WAN DATA] Résultat reçu.");
            dataReceived = true;
            const video = extractVideoValue(message.data);
            if (video) {
              finalVideo = video;
              console.log("[WAN DATA] URL vidéo:", video);
              // La donnée est là : on n'attend pas forcément "complete".
              return finish(resolve, { video: finalVideo, status: lastStatus });
            } else {
              console.log(
                "[WAN DATA] Contenu brut:",
                JSON.stringify(message.data).slice(0, 1000),
              );
            }
          }
        }

        if (finalVideo) finish(resolve, { video: finalVideo, status: lastStatus });
        else
          finish(
            reject,
            new Error("Le job Wan 2.2 est terminé mais aucune vidéo n'a été retournée."),
          );
      } catch (error) {
        finish(reject, error);
      }
    })();
  });
}

// Télécharge la vidéo depuis Hugging Face (URL temporaire, parfois protégée)
// et la sert depuis /uploads pour que le frontend ait une URL stable.
async function saveVideoLocally(videoUrl, req) {
  const headers = HF_TOKEN ? { Authorization: `Bearer ${HF_TOKEN}` } : {};
  const response = await fetch(videoUrl, { headers });
  if (!response.ok) {
    throw new Error(`Téléchargement vidéo impossible. HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-wan.mp4`;
  fs.writeFileSync(path.join(uploadsDir, filename), buffer);
  console.log("Vidéo enregistrée:", filename, buffer.length, "bytes");
  return `${req.protocol}://${req.get("host")}/uploads/${filename}`;
}

function numberOr(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function booleanOr(value, fallback) {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === 1 || value === "1") return true;
  if (value === "false" || value === 0 || value === "0") return false;
  return fallback;
}

app.post("/api/generate-video", async (req, res) => {
  const startedAt = Date.now();

  try {
    if (!HF_TOKEN) {
      return res.status(500).json({
        success: false,
        error: "HF_TOKEN n'est pas configuré dans l'environnement.",
      });
    }

    const {
      scene,
      sceneData,
      imageUrl,
      prompt,
      duration,
      steps,
      guidanceScale,
      guidanceScale2,
      seed,
      randomizeSeed,
    } = req.body || {};

    const data = sceneData || scene || {};
    const finalImageUrl = normalizeImageUrl(imageUrl || findFirstImage(data));

    if (!finalImageUrl) {
      return res.status(400).json({
        success: false,
        error: "Aucune image de référence n'a été trouvée pour cette scène.",
      });
    }

    console.log("Image utilisée:", finalImageUrl);

    let imageBuffer;
    if (/^https?:\/\//i.test(finalImageUrl)) {
      const imageResponse = await fetch(finalImageUrl);
      if (!imageResponse.ok) {
        throw new Error(
          `Impossible de télécharger l'image. HTTP ${imageResponse.status}`,
        );
      }

      imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
      console.log("Image téléchargée:", imageBuffer.length, "bytes");
    } else {
      const localPath = resolveLocalUploadPath(finalImageUrl);
      if (!fs.existsSync(localPath)) {
        throw new Error(`Image introuvable: ${localPath}`);
      }

      imageBuffer = fs.readFileSync(localPath);
      console.log("Image lue depuis le disque:", localPath);
    }

    const finalPrompt = prompt || buildVideoPrompt(data);
    const finalSteps = numberOr(steps, 4);
    const finalDuration = Math.min(Math.max(numberOr(duration, 5), 1), 5);
    const finalGuidanceScale = numberOr(guidanceScale, 1);
    const finalGuidanceScale2 = numberOr(guidanceScale2, 1);
    const finalSeed = numberOr(seed, 42);
    const finalRandomizeSeed = booleanOr(randomizeSeed, false);

    console.log("Connexion Hugging Face...");
    const client = await Client.connect(HF_SPACE, {
      token: HF_TOKEN,
      events: ["data", "status"],
    });
    console.log("Connexion Hugging Face réussie.");

    console.log("Soumission du job Wan 2.2...");
    const job = client.submit("/generate_video", [
      imageBuffer,
      finalPrompt,
      finalSteps,
      "blurry, low quality, distorted face, deformed body, extra limbs, bad anatomy, text, watermark",
      finalDuration,
      finalGuidanceScale,
      finalGuidanceScale2,
      finalSeed,
      finalRandomizeSeed,
    ]);

    console.log("Job Wan 2.2 soumis. Surveillance de la file...");
    const result = await waitForWanJob(job);
    const elapsed = Math.round((Date.now() - startedAt) / 1000);

    console.log(`Vidéo Wan 2.2 terminée après ${elapsed}s.`);
    console.log("URL vidéo:", result.video);

    let publicVideo = result.video;
    try {
      publicVideo = await saveVideoLocally(result.video, req);
    } catch (error) {
      console.error("Copie locale échouée, URL Hugging Face renvoyée:", error?.message);
    }

    return res.json({
      success: true,
      video: publicVideo,
      videoUrl: publicVideo,
      originalVideoUrl: result.video,
      result: {
        video: publicVideo,
        status: result.status,
        duration: finalDuration,
        elapsedSeconds: elapsed,
      },
    });
  } catch (error) {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    console.error("Erreur génération Wan 2.2:", error);

    return res.status(500).json({
      success: false,
      error:
        error?.message ||
        "Erreur pendant la génération vidéo Wan 2.2.",
      elapsedSeconds: elapsed,
    });
  }
});

// Route de test/compatibilité ; la génération Wan passe par /api/generate-video.
app.post("/api/generate", (req, res) => {
  const { prompt, scene } = req.body || {};
  return res.json({
    success: true,
    message:
      "Endpoint /api/generate disponible. Utiliser /api/generate-video pour Wan 2.2.",
    prompt: prompt || "",
    scene: scene || null,
  });
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    console.error("ERREUR MULTER:", error.code);
    return res.status(400).json({
      success: false,
      message: `Erreur upload Multer: ${error.code}`,
    });
  }

  console.error("ERREUR SERVEUR:", error);
  return res.status(500).json({
    success: false,
    message: error?.message || "Erreur serveur.",
  });
});

app.listen(PORT, () => {
  console.log("==========================================");
  console.log("Cinema AI Backend");
  console.log(`Port: ${PORT}`);
  console.log(`Wan 2.2 timeout: ${WAN_TIMEOUT_MS / 60000} minutes`);
  console.log(`Hugging Face Space: ${HF_SPACE}`);
  console.log(`HF_TOKEN configuré: ${HF_TOKEN ? "OUI" : "NON"}`);
  console.log("==========================================");
});
