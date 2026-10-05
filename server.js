
import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Client } from "@gradio/client";

/* =========================================================
   CONFIGURATION
========================================================= */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = process.env.PORT || 3000;

const HF_TOKEN = process.env.HF_TOKEN;

const HF_SPACE =
  "zerogpu-aoti/wan2-2-fp8da-aoti-faster";

const WAN_TIMEOUT_MS = 8 * 60 * 1000;

/* =========================================================
   DOSSIERS
========================================================= */

const uploadsDir = path.join(
  __dirname,
  "uploads"
);

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, {
    recursive: true,
  });
}

/* =========================================================
   MIDDLEWARE
========================================================= */

app.use(
  cors({
    origin: "*",
  })
);

app.use(
  express.json({
    limit: "50mb",
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "50mb",
  })
);

app.use(
  "/uploads",
  express.static(uploadsDir)
);

/* =========================================================
   MULTER
========================================================= */

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },

  filename: (_req, file, cb) => {
    const timestamp = Date.now();

    const random =
      Math.random()
        .toString(36)
        .substring(2, 8);

    const safeName =
      file.originalname
        .replace(/[^a-zA-Z0-9._-]/g, "-");

    cb(
      null,
      `${timestamp}-${random}-${safeName}`
    );
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 500 * 1024 * 1024,
  },
});

/* =========================================================
   OUTILS
========================================================= */

function formatEta(eta) {
  if (
    eta === null ||
    eta === undefined ||
    Number.isNaN(Number(eta))
  ) {
    return "?";
  }

  const seconds = Number(eta);

  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }

  return `${Math.round(seconds / 60)}min`;
}

/* =========================================================
   EXTRACTION VIDEO
========================================================= */

function extractVideoValue(data) {
  if (!data) {
    return null;
  }

  /*
   * Cas classique :
   *
   * data = [
   *   {
   *     video: "...",
   *     subtitles: ...
   *   }
   * ]
   */

  if (Array.isArray(data)) {
    for (const item of data) {
      const result = extractVideoValue(item);

      if (result) {
        return result;
      }
    }

    return null;
  }

  /*
   * String directe
   */

  if (typeof data === "string") {
    if (
      data.startsWith("http://") ||
      data.startsWith("https://")
    ) {
      return data;
    }

    return null;
  }

  /*
   * Objet
   */

  if (typeof data === "object") {
    const possibleKeys = [
      "video",
      "url",
      "path",
      "file",
      "value",
    ];

    for (const key of possibleKeys) {
      if (
        data[key] !== undefined &&
        data[key] !== null
      ) {
        const result =
          extractVideoValue(data[key]);

        if (result) {
          return result;
        }
      }
    }
  }

  return null;
}

/* =========================================================
   NORMALISATION IMAGE
========================================================= */

function normalizeImageUrl(imageUrl) {
  if (!imageUrl) {
    return null;
  }

  /*
   * URL Railway
   */

  if (
    imageUrl.startsWith("http://") ||
    imageUrl.startsWith("https://")
  ) {
    return imageUrl;
  }

  /*
   * URL locale /uploads/...
   */

  if (
    imageUrl.startsWith("/uploads/")
  ) {
    return imageUrl;
  }

  /*
   * chemin local
   */

  if (
    imageUrl.startsWith("uploads/")
  ) {
    return `/${imageUrl}`;
  }

  return imageUrl;
}

/* =========================================================
   TROUVER UNE IMAGE DANS LA SCÈNE
========================================================= */

function findFirstImage(sceneData) {
  if (!sceneData) {
    return null;
  }

  /*
   * 1. Image directe
   */

  if (sceneData.imageUrl) {
    return normalizeImageUrl(
      sceneData.imageUrl
    );
  }

  if (sceneData.image) {
    return normalizeImageUrl(
      sceneData.image
    );
  }

  /*
   * 2. Personnages
   */

  if (
    Array.isArray(sceneData.characters)
  ) {
    for (const character of sceneData.characters) {
      if (!character) {
        continue;
      }

      /*
       * imageReferences
       */

      if (
        Array.isArray(
          character.imageReferences
        )
      ) {
        for (
          const image of character.imageReferences
        ) {
          if (!image) {
            continue;
          }

          if (image.storageUrl) {
            return normalizeImageUrl(
              image.storageUrl
            );
          }

          if (image.url) {
            return normalizeImageUrl(
              image.url
            );
          }
        }
      }

      /*
       * ancienne structure éventuelle
       */

      if (character.imageUrl) {
        return normalizeImageUrl(
          character.imageUrl
        );
      }

      if (character.image) {
        return normalizeImageUrl(
          character.image
        );
      }
    }
  }

  /*
   * 3. Locations
   */

  if (
    Array.isArray(sceneData.locations)
  ) {
    for (const location of sceneData.locations) {
      if (!location) {
        continue;
      }

      if (
        Array.isArray(
          location.imageReferences
        )
      ) {
        for (
          const image of location.imageReferences
        ) {
          if (!image) {
            continue;
          }

          if (image.storageUrl) {
            return normalizeImageUrl(
              image.storageUrl
            );
          }

          if (image.url) {
            return normalizeImageUrl(
              image.url
            );
          }
        }
      }

      if (location.imageUrl) {
        return normalizeImageUrl(
          location.imageUrl
        );
      }

      if (location.image) {
        return normalizeImageUrl(
          location.image
        );
      }
    }
  }

  /*
   * 4. Images de référence de scène
   */

  if (
    Array.isArray(
      sceneData.referenceImages
    )
  ) {
    for (
      const image of sceneData.referenceImages
    ) {
      if (!image) {
        continue;
      }

      if (typeof image === "string") {
        return normalizeImageUrl(image);
      }

      if (image.storageUrl) {
        return normalizeImageUrl(
          image.storageUrl
        );
      }

      if (image.url) {
        return normalizeImageUrl(
          image.url
        );
      }
    }
  }

  /*
   * 5. Style visuel
   */

  if (
    sceneData.visualStyle &&
    Array.isArray(
      sceneData.visualStyle.images
    )
  ) {
    for (
      const image of sceneData.visualStyle.images
    ) {
      if (!image) {
        continue;
      }

      if (typeof image === "string") {
        return normalizeImageUrl(image);
      }

      if (image.storageUrl) {
        return normalizeImageUrl(
          image.storageUrl
        );
      }

      if (image.url) {
        return normalizeImageUrl(
          image.url
        );
      }
    }
  }

  return null;
}

/* =========================================================
   CONSTRUIRE LE PROMPT VIDEO
========================================================= */

function buildVideoPrompt(sceneData) {
  if (!sceneData) {
    return "Create a cinematic realistic video.";
  }

  const parts = [];

  /*
   * Description
   */

  if (sceneData.description) {
    parts.push(
      `Scene description: ${sceneData.description}`
    );
  }

  /*
   * Action
   */

  if (sceneData.action) {
    parts.push(
      `Action and staging: ${sceneData.action}`
    );
  }

  /*
   * Personnages
   */

  if (
    Array.isArray(sceneData.characters) &&
    sceneData.characters.length > 0
  ) {
    const characters =
      sceneData.characters
        .map((character) => {
          if (!character) {
            return null;
          }

          const name =
            character.name || "character";

          const description =
            character.description || "";

          return description
            ? `${name}: ${description}`
            : name;
        })
        .filter(Boolean)
        .join(", ");

    if (characters) {
      parts.push(
        `Characters: ${characters}`
      );
    }
  }

  /*
   * Lieux
   */

  if (
    Array.isArray(sceneData.locations) &&
    sceneData.locations.length > 0
  ) {
    const locations =
      sceneData.locations
        .map((location) => {
          if (!location) {
            return null;
          }

          return (
            location.name ||
            location.title ||
            location.description ||
            null
          );
        })
        .filter(Boolean)
        .join(", ");

    if (locations) {
      parts.push(
        `Locations: ${locations}`
      );
    }
  }

  /*
   * Mouvements
   */

  if (
    Array.isArray(sceneData.movements) &&
    sceneData.movements.length > 0
  ) {
    const movements =
      sceneData.movements
        .map((movement) => {
          if (!movement) {
            return null;
          }

          const action =
            movement.action ||
            movement.name ||
            movement.description ||
            "";

          const destination =
            movement.destination
              ? ` toward ${movement.destination}`
              : "";

          return `${action}${destination}`;
        })
        .filter(Boolean)
        .join(". ");

    if (movements) {
      parts.push(
        `Movement sequence: ${movements}`
      );
    }
  }

  /*
   * Dialogue
   */

  if (sceneData.dialogue) {
    parts.push(
      `Dialogue: ${sceneData.dialogue}`
    );
  }

  /*
   * Style visuel
   */

  if (sceneData.visualStyle) {
    const visualText =
      typeof sceneData.visualStyle ===
      "string"
        ? sceneData.visualStyle
        : sceneData.visualStyle.text || "";

    if (visualText) {
      parts.push(
        `Visual style: ${visualText}`
      );
    }
  }

  /*
   * Instructions cinématiques
   */

  parts.push(
    "Cinematic realistic video, natural human movement, realistic facial expressions, realistic body proportions, coherent environment, cinematic lighting, subtle camera movement, consistent characters and locations, high visual quality."
  );

  return parts.join("\n\n");
}

/* =========================================================
   UPLOAD ASSETS
========================================================= */

app.post(
  "/api/assets",
  upload.single("file"),
  (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: "Aucun fichier reçu.",
        });
      }

      const publicUrl =
        `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;

      console.log(
        "Asset uploadé:",
        req.file.filename
      );

      return res.json({
        success: true,

        file: {
          name: req.file.originalname,

          filename: req.file.filename,

          url: publicUrl,

          storageUrl: publicUrl,

          path: req.file.path,

          size: req.file.size,

          mimetype: req.file.mimetype,

          uploaded: true,
        },
      });
    } catch (error) {
      console.error(
        "Erreur upload asset:",
        error
      );

      return res.status(500).json({
        success: false,
        error:
          error?.message ||
          "Erreur pendant l'upload.",
      });
    }
  }
);

/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/",
  (_req, res) => {
    res.json({
      success: true,
      service: "Cinema AI Backend",
      status: "online",
      wanSpace: HF_SPACE,
      wanTimeoutMinutes:
        WAN_TIMEOUT_MS / 60000,
    });
  }
);

app.get(
  "/api/health",
  (_req, res) => {
    res.json({
      success: true,
      status: "ok",

      hfConfigured:
        Boolean(HF_TOKEN),

      wanSpace:
        HF_SPACE,
    });
  }
);

/* =========================================================
   TEST HF
========================================================= */

app.get(
  "/api/test-huggingface",
  async (_req, res) => {
    try {
      if (!HF_TOKEN) {
        return res.status(500).json({
          success: false,
          error:
            "HF_TOKEN n'est pas configuré dans Railway.",
        });
      }

      console.log(
        "Test connexion Hugging Face..."
      );

      const client =
        await Client.connect(
          HF_SPACE,
          {
            token: HF_TOKEN,
            events: [
              "data",
              "status",
            ],
          }
        );

      console.log(
        "Connexion Hugging Face réussie."
      );

      return res.json({
        success: true,

        message:
          "Connexion Hugging Face réussie.",

        space: HF_SPACE,
      });
    } catch (error) {
      console.error(
        "Erreur Hugging Face:",
        error
      );

      return res.status(500).json({
        success: false,

        error:
          error?.message ||
          "Impossible de se connecter à Hugging Face.",
      });
    }
  }
);

/* =========================================================
   ATTENDRE JOB WAN 2.2
========================================================= */

async function waitForWanJob(job) {
  const startedAt = Date.now();

  let timeoutTimer;

  /*
   * TIMEOUT
   */

  const timeoutPromise =
    new Promise((_, reject) => {
      timeoutTimer = setTimeout(
        async () => {
          const elapsed =
            Math.round(
              (Date.now() - startedAt) /
                1000
            );

          console.error(
            `Timeout Wan 2.2 après ${elapsed}s.`
          );

          try {
            if (
              job &&
              typeof job.cancel ===
                "function"
            ) {
              console.log(
                "Annulation du job Wan 2.2..."
              );

              await job.cancel();

              console.log(
                "Job Wan 2.2 annulé."
              );
            }
          } catch (error) {
            console.error(
              "Erreur pendant l'annulation:",
              error?.message || error
            );
          }

          reject(
            new Error(
              `Le Space Wan 2.2 n'a pas terminé après ${Math.round(
                WAN_TIMEOUT_MS / 60000
              )} minutes. Le job a été annulé.`
            )
          );
        },
        WAN_TIMEOUT_MS
      );
    });

  /*
   * JOB
   */

  const jobPromise =
    (async () => {
      let finalVideo = null;

      let lastStatus = null;

      /*
       * API ACTUELLE GRADIO
       *
       * On parcourt directement le job.
       */

      for await (const message of job) {
        if (!message) {
          continue;
        }

        /*
         * STATUS
         */

        if (
          message.type === "status"
        ) {
          lastStatus = message;

          const stage =
            message.stage ||
            message.status ||
            "unknown";

          const position =
            message.position ??
            "?";

          const queueSize =
            message.size ??
            message.queue_size ??
            "?";

          const eta =
            formatEta(message.eta);

          const elapsed =
            Math.round(
              (Date.now() - startedAt) /
                1000
            );

          console.log(
            `[WAN STATUS] stage=${stage} | position=${position} | queue=${queueSize} | ETA=${eta} | elapsed=${elapsed}s`
          );

          /*
           * Erreur signalée par le Space
           */

          if (
            stage === "error"
          ) {
            throw new Error(
              message.message ||
                message.code ||
                "Le Space Wan 2.2 a signalé une erreur."
            );
          }
        }

        /*
         * DATA
         */

        if (
          message.type === "data"
        ) {
          console.log(
            "[WAN DATA] Résultat reçu."
          );

          console.log(
            "[WAN DATA RAW]",
            JSON.stringify(
              message.data,
              null,
              2
            )
          );

          const video =
            extractVideoValue(
              message.data
            );

          if (video) {
            finalVideo = video;
          }
        }
      }

      /*
       * FIN
       */

      if (!finalVideo) {
        throw new Error(
          "Le job Wan 2.2 est terminé mais aucune vidéo n'a été retournée."
        );
      }

      return {
        video: finalVideo,

        status: lastStatus,
      };
    })();

  try {
    return await Promise.race([
      jobPromise,
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(timeoutTimer);
  }
}

/* =========================================================
   GENERATION VIDEO WAN 2.2
========================================================= */

app.post(
  "/api/generate-video",
  async (req, res) => {
    const startedAt = Date.now();

    try {
      console.log("");
      console.log(
        "=========================================="
      );
      console.log(
        "DEMANDE VIDEO WAN 2.2"
      );
      console.log(
        "=========================================="
      );

      /*
       * Vérification token
       */

      if (!HF_TOKEN) {
        console.error(
          "HF_TOKEN absent."
        );

        return res.status(500).json({
          success: false,

          error:
            "HF_TOKEN n'est pas configuré dans Railway.",
        });
      }

      /*
       * Données reçues
       */

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

      const data =
        sceneData ||
        scene ||
        {};

      /*
       * IMAGE
       */

      let finalImageUrl =
        imageUrl ||
        findFirstImage(data);

      finalImageUrl =
        normalizeImageUrl(
          finalImageUrl
        );

      if (!finalImageUrl) {
        console.error(
          "Aucune image trouvée."
        );

        return res.status(400).json({
          success: false,

          error:
            "Aucune image de référence n'a été trouvée pour cette scène.",
        });
      }

      console.log(
        "Image utilisée:",
        finalImageUrl
      );

      /*
       * L'image doit être une URL Railway
       */

      let imageBuffer;

      if (
        finalImageUrl.startsWith(
          "http://"
        ) ||
        finalImageUrl.startsWith(
          "https://"
        )
      ) {
        /*
         * URL distante
         */

        console.log(
          "Téléchargement de l'image..."
        );

        const imageResponse =
          await fetch(
            finalImageUrl
          );

        if (!imageResponse.ok) {
          throw new Error(
            `Impossible de télécharger l'image. HTTP ${imageResponse.status}`
          );
        }

        imageBuffer =
          Buffer.from(
            await imageResponse.arrayBuffer()
          );

        console.log(
          "Image téléchargée:",
          imageBuffer.length,
          "bytes"
        );
      } else {
        /*
         * chemin local
         */

        let localPath =
          finalImageUrl;

        if (
          localPath.startsWith("/")
        ) {
          localPath =
            path.join(
              __dirname,
              localPath
                .replace(/^\/+/, "")
            );
        } else {
          localPath =
            path.join(
              __dirname,
              localPath
            );
        }

        console.log(
          "Image lue depuis le disque:",
          localPath
        );

        if (
          !fs.existsSync(localPath)
        ) {
          throw new Error(
            `Image introuvable: ${localPath}`
          );
        }

        imageBuffer =
          fs.readFileSync(
            localPath
          );
      }

      console.log(
        "Image prête."
      );

      /*
       * PROMPT
       */

      const finalPrompt =
        prompt ||
        buildVideoPrompt(data);

      console.log(
        "Prompt Wan 2.2:"
      );

      console.log(
        finalPrompt
      );

      /*
       * PARAMÈTRES
       */

      const finalSteps =
        Number.isFinite(
          Number(steps)
        )
          ? Number(steps)
          : 4;

      const finalDuration =
        Number.isFinite(
          Number(duration)
        )
          ? Math.min(
              Math.max(
                Number(duration),
                1
              ),
              5
            )
          : 5;

      const finalGuidanceScale =
        Number.isFinite(
          Number(guidanceScale)
        )
          ? Number(guidanceScale)
          : 1;

      const finalGuidanceScale2 =
        Number.isFinite(
          Number(guidanceScale2)
        )
          ? Number(guidanceScale2)
          : 1;

      const finalSeed =
        Number.isFinite(
          Number(seed)
        )
          ? Number(seed)
          : 42;

      const finalRandomizeSeed =
        Boolean(
          randomizeSeed
        );

      /*
       * CONNEXION HF
       */

      console.log(
        "Connexion Hugging Face..."
      );

      const client =
        await Client.connect(
          HF_SPACE,
          {
            token: HF_TOKEN,

            events: [
              "data",
              "status",
            ],
          }
        );

      console.log(
        "Connexion Hugging Face réussie."
      );

      /*
       * JOB
       *
       * IMPORTANT:
       * Les composants du Space Wan2.2 sont :
       *
       * 1 image
       * 2 prompt
       * 3 steps
       * 4 negative prompt
       * 5 duration
       * 6 guidance scale
       * 7 guidance scale 2
       * 8 seed
       * 9 randomize seed
       */

      console.log(
        "Soumission du job Wan 2.2..."
      );

      const job =
        client.submit(
          "/generate_video",
          [
            imageBuffer,

            finalPrompt,

            finalSteps,

            "blurry, low quality, distorted face, deformed body, extra limbs, bad anatomy, text, watermark",

            finalDuration,

            finalGuidanceScale,

            finalGuidanceScale2,

            finalSeed,

            finalRandomizeSeed,
          ]
        );

      console.log(
        "Job Wan 2.2 soumis."
      );

      console.log(
        "Surveillance de la file..."
      );

      /*
       * ATTENTE
       */

      const result =
        await waitForWanJob(
          job
        );

      /*
       * DURÉE
       */

      const elapsed =
        Math.round(
          (Date.now() - startedAt) /
            1000
        );

      console.log(
        `Vidéo Wan 2.2 terminée après ${elapsed}s.`
      );

      console.log(
        "URL vidéo:",
        result.video
      );

      /*
       * RÉPONSE
       */

      return res.json({
        success: true,

        video: result.video,

        result: {
          video: result.video,

          status: result.status,

          duration: finalDuration,

          elapsedSeconds:
            elapsed,
        },
      });
    } catch (error) {
      const elapsed =
        Math.round(
          (Date.now() - startedAt) /
            1000
        );

      console.error("");
      console.error(
        "=========================================="
      );
      console.error(
        "ERREUR GENERATION WAN 2.2"
      );
      console.error(
        "=========================================="
      );

      console.error(
        "Temps:",
        elapsed,
        "secondes"
      );

      console.error(
        error
      );

      return res.status(500).json({
        success: false,

        error:
          error?.message ||
          "Erreur pendant la génération vidéo Wan 2.2.",

        elapsedSeconds:
          elapsed,
      });
    }
  }
);

/* =========================================================
   ANCIEN ENDPOINT GENERATE
========================================================= */

app.post(
  "/api/generate",
  async (req, res) => {
    try {
      const {
        prompt,
        scene,
      } = req.body || {};

      return res.json({
        success: true,

        message:
          "Endpoint /api/generate disponible. Utiliser /api/generate-video pour Wan 2.2.",

        prompt:
          prompt || "",

        scene:
          scene || null,
      });
    } catch (error) {
      return res.status(500).json({
        success: false,

        error:
          error?.message ||
          "Erreur.",
      });
    }
  }
);

/* =========================================================
   GESTION ERREURS EXPRESS
========================================================= */

app.use(
  (
    error,
    _req,
    res,
    _next
  ) => {
    console.error(
      "Erreur Express:",
      error
    );

    return res.status(500).json({
      success: false,

      error:
        error?.message ||
        "Erreur serveur.",
    });
  }
);

/* =========================================================
   DÉMARRAGE
========================================================= */

app.listen(
  PORT,
  () => {
    console.log("");
    console.log(
      "=========================================="
    );

    console.log(
      "Cinema AI Backend"
    );

    console.log(
      "=========================================="
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `Wan 2.2 timeout: ${
        WAN_TIMEOUT_MS / 60000
      } minutes`
    );

    console.log(
      `Hugging Face Space: ${HF_SPACE}`
    );

    console.log(
      `HF_TOKEN configuré: ${
        HF_TOKEN ? "OUI" : "NON"
      }`
    );

    console.log(
      "=========================================="
    );
  }
);
