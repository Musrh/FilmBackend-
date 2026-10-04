
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

// ============================================================
// HUGGING FACE / WAN 2.2
// ============================================================

const HF_TOKEN = process.env.HF_TOKEN || "";

const HF_SPACE =
  "zerogpu-aoti/wan2-2-fp8da-aoti-faster";

const WAN_ENABLED = Boolean(HF_TOKEN);

// Timeout maximum d'une génération.
// 8 minutes = 480 secondes.
const WAN_TIMEOUT_MS = 8 * 60 * 1000;

// Fréquence d'affichage du statut.
const WAN_STATUS_INTERVAL_MS = 5000;

// ============================================================
// EXPRESS
// ============================================================

app.use(cors());

app.use(
  express.json({
    limit: "10mb",
  })
);

// ============================================================
// DOSSIER UPLOADS
// ============================================================

const uploadsDir = path.join(
  __dirname,
  "uploads"
);

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, {
    recursive: true,
  });
}

// ============================================================
// MULTER
// ============================================================

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },

  filename: (_req, file, cb) => {
    const safeName = (
      file.originalname || "image.jpg"
    ).replace(
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

// Les fichiers deviennent accessibles par /uploads/...
app.use(
  "/uploads",
  express.static(uploadsDir)
);

// ============================================================
// HELPERS GENERAUX
// ============================================================

function sleep(ms) {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}

function safeNumber(value, fallback) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}

function clamp(value, min, max) {
  return Math.min(
    max,
    Math.max(min, value)
  );
}

function formatEta(eta) {
  if (
    eta === null ||
    eta === undefined
  ) {
    return "inconnue";
  }

  const number = Number(eta);

  if (!Number.isFinite(number)) {
    return String(eta);
  }

  if (number < 60) {
    return `${Math.round(number)}s`;
  }

  return `${Math.round(
    number / 60
  )}min`;
}

// ============================================================
// EXTRACTION RESULTAT VIDEO
// ============================================================

function extractVideoValue(data) {
  if (!data) {
    return null;
  }

  // Tableau de résultats
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return null;
    }

    return extractVideoValue(
      data[0]
    );
  }

  // URL directe
  if (typeof data === "string") {
    return {
      url: data,
    };
  }

  // Objet Gradio
  if (
    typeof data === "object"
  ) {
    if (data.url) {
      return {
        ...data,
        url: data.url,
      };
    }

    if (data.path) {
      return {
        ...data,
        url: data.path,
      };
    }

    if (data.video) {
      return extractVideoValue(
        data.video
      );
    }

    if (data.data) {
      return extractVideoValue(
        data.data
      );
    }
  }

  return null;
}

// ============================================================
// RECHERCHE PREMIERE IMAGE
// ============================================================

function findFirstImage(sceneData) {
  // ----------------------------------------------------------
  // PERSONNAGES
  // ----------------------------------------------------------

  const characters =
    Array.isArray(
      sceneData?.characters
    )
      ? sceneData.characters
      : [];

  for (
    const character of characters
  ) {
    const refs =
      Array.isArray(
        character?.imageReferences
      )
        ? character.imageReferences
        : [];

    for (
      const image of refs
    ) {
      if (
        image?.url &&
        !String(
          image.url
        ).startsWith("blob:")
      ) {
        return image.url;
      }

      if (
        image?.storageUrl &&
        !String(
          image.storageUrl
        ).startsWith("blob:")
      ) {
        return image.storageUrl;
      }
    }
  }

  // ----------------------------------------------------------
  // LIEUX
  // ----------------------------------------------------------

  const locations =
    Array.isArray(
      sceneData?.locations
    )
      ? sceneData.locations
      : [];

  for (
    const location of locations
  ) {
    const refs =
      Array.isArray(
        location?.imageReferences
      )
        ? location.imageReferences
        : [];

    for (
      const image of refs
    ) {
      if (
        image?.url &&
        !String(
          image.url
        ).startsWith("blob:")
      ) {
        return image.url;
      }

      if (
        image?.storageUrl &&
        !String(
          image.storageUrl
        ).startsWith("blob:")
      ) {
        return image.storageUrl;
      }
    }
  }

  // ----------------------------------------------------------
  // REFERENCES SCENE
  // ----------------------------------------------------------

  const referenceImages =
    Array.isArray(
      sceneData?.referenceImages
    )
      ? sceneData.referenceImages
      : [];

  for (
    const image of referenceImages
  ) {
    if (
      image?.url &&
      !String(
        image.url
      ).startsWith("blob:")
    ) {
      return image.url;
    }

    if (
      image?.storageUrl &&
      !String(
        image.storageUrl
      ).startsWith("blob:")
    ) {
      return image.storageUrl;
    }
  }

  // ----------------------------------------------------------
  // STYLE VISUEL
  // ----------------------------------------------------------

  const visualImages =
    Array.isArray(
      sceneData?.visualStyle
        ?.images
    )
      ? sceneData.visualStyle.images
      : [];

  for (
    const image of visualImages
  ) {
    if (
      image?.url &&
      !String(
        image.url
      ).startsWith("blob:")
    ) {
      return image.url;
    }

    if (
      image?.storageUrl &&
      !String(
        image.storageUrl
      ).startsWith("blob:")
    ) {
      return image.storageUrl;
    }
  }

  return null;
}

// ============================================================
// CONSTRUCTION DU PROMPT
// ============================================================

function buildVideoPrompt(sceneData) {
  const scene =
    sceneData?.scene || {};

  // ----------------------------------------------------------
  // PERSONNAGES
  // ----------------------------------------------------------

  const characters =
    Array.isArray(
      sceneData?.characters
    )
      ? sceneData.characters
          .map(
            (character) =>
              character?.name
          )
          .filter(Boolean)
      : [];

  // ----------------------------------------------------------
  // LIEUX
  // ----------------------------------------------------------

  const locations =
    Array.isArray(
      sceneData?.locations
    )
      ? sceneData.locations
          .map(
            (location) =>
              location?.name
          )
          .filter(Boolean)
      : [];

  // ----------------------------------------------------------
  // MOUVEMENTS
  // ----------------------------------------------------------

  const movements =
    Array.isArray(
      sceneData?.movements
    )
      ? sceneData.movements
          .map(
            (movement) => {
              const text =
                movement?.text ||
                movement?.description ||
                "";

              const destination =
                movement?.destination ||
                "";

              if (
                text &&
                destination
              ) {
                return `${text} vers ${destination}`;
              }

              return (
                text ||
                destination
              );
            }
          )
          .filter(Boolean)
      : [];

  // ----------------------------------------------------------
  // STYLE
  // ----------------------------------------------------------

  let visualStyle = "";

  if (
    typeof sceneData?.visualStyle ===
    "object"
  ) {
    visualStyle =
      sceneData
        ?.visualStyle
        ?.text || "";
  } else {
    visualStyle =
      sceneData?.visualStyle ||
      "";
  }

  // ----------------------------------------------------------
  // PROMPT FINAL
  // ----------------------------------------------------------

  const parts = [
    "Cinematic realistic live-action video.",

    scene.title
      ? `Scene: ${scene.title}.`
      : "",

    scene.description
      ? `Description: ${scene.description}.`
      : "",

    characters.length
      ? `Characters: ${characters.join(
          ", "
        )}.`
      : "",

    locations.length
      ? `Locations: ${locations.join(
          ", "
        )}.`
      : "",

    movements.length
      ? `Movements: ${movements.join(
          "; "
        )}.`
      : "",

    sceneData?.action
      ? `Action and staging: ${sceneData.action}.`
      : "",

    sceneData?.dialogue
      ? `Dialogue: ${sceneData.dialogue}.`
      : "",

    visualStyle
      ? `Visual style: ${visualStyle}.`
      : "",

    "Natural human motion, coherent anatomy, realistic facial expression, subtle cinematic camera movement, cinematic lighting, high detail.",
  ];

  return parts
    .filter(Boolean)
    .join(" ");
}

// ============================================================
// LECTURE IMAGE
// ============================================================

async function readLocalImageFromUrl(
  imageUrl
) {
  if (!imageUrl) {
    throw new Error(
      "URL de l'image manquante."
    );
  }

  // Une URL blob ne doit jamais arriver ici.
  if (
    imageUrl.startsWith("blob:")
  ) {
    throw new Error(
      "Une URL blob: ne peut pas être envoyée au backend."
    );
  }

  // ----------------------------------------------------------
  // IMAGE LOCALE /uploads
  // ----------------------------------------------------------

  try {
    const parsed =
      new URL(imageUrl);

    const pathname =
      decodeURIComponent(
        parsed.pathname
      );

    if (
      pathname.startsWith(
        "/uploads/"
      )
    ) {
      const filename =
        path.basename(
          pathname
        );

      const localPath =
        path.join(
          uploadsDir,
          filename
        );

      if (
        fs.existsSync(
          localPath
        )
      ) {
        console.log(
          "Image lue depuis le disque:",
          localPath
        );

        return fs.readFileSync(
          localPath
        );
      }
    }
  } catch (error) {
    console.log(
      "Lecture locale impossible, fallback réseau:",
      error.message
    );
  }

  // ----------------------------------------------------------
  // IMAGE EXTERNE
  // ----------------------------------------------------------

  console.log(
    "Téléchargement de l'image distante..."
  );

  const response =
    await fetch(imageUrl);

  if (!response.ok) {
    throw new Error(
      `Impossible de télécharger l'image (${response.status} ${response.statusText}).`
    );
  }

  const arrayBuffer =
    await response.arrayBuffer();

  return Buffer.from(
    arrayBuffer
  );
}

// ============================================================
// ATTENDRE WAN 2.2
// ============================================================

async function waitForWanJob(
  job
) {
  return new Promise(
    (resolve, reject) => {
      let finished = false;

      let lastStatus = null;
      let lastData = null;

      let statusTimer = null;
      let timeoutTimer = null;

      const startedAt =
        Date.now();

      // ------------------------------------------------------
      // NETTOYAGE
      // ------------------------------------------------------

      const cleanup = () => {
        if (statusTimer) {
          clearInterval(
            statusTimer
          );

          statusTimer = null;
        }

        if (timeoutTimer) {
          clearTimeout(
            timeoutTimer
          );

          timeoutTimer = null;
        }
      };

      // ------------------------------------------------------
      // FIN
      // ------------------------------------------------------

      const finishSuccess = (
        value
      ) => {
        if (finished) {
          return;
        }

        finished = true;

        cleanup();

        resolve({
          video: value,
          status: lastStatus,
        });
      };

      // ------------------------------------------------------
      // ERREUR
      // ------------------------------------------------------

      const finishError = (
        error
      ) => {
        if (finished) {
          return;
        }

        finished = true;

        cleanup();

        reject(error);
      };

      // ------------------------------------------------------
      // AFFICHAGE STATUS
      // ------------------------------------------------------

      const printStatus = (
        status
      ) => {
        if (!status) {
          return;
        }

        lastStatus =
          status;

        const state =
          status.status ||
          "unknown";

        const position =
          status.position !==
            undefined &&
          status.position !==
            null
            ? status.position
            : "?";

        const queueSize =
          status.queue_size !==
            undefined &&
          status.queue_size !==
            null
            ? status.queue_size
            : "?";

        const eta =
          formatEta(
            status.eta
          );

        const elapsed =
          Math.round(
            (Date.now() -
              startedAt) /
              1000
          );

        console.log(
          `[WAN STATUS] ${state} | position=${position} | queue=${queueSize} | ETA=${eta} | elapsed=${elapsed}s`
        );

        // Erreur remontée par Gradio.
        if (
          state === "error"
        ) {
          finishError(
            new Error(
              status.code ||
                "Le Space Wan 2.2 a signalé une erreur."
            )
          );
        }

        // Si le statut dit terminé mais qu'aucune
        // donnée n'est encore disponible, on attend
        // le message data.
        if (
          state ===
            "complete" &&
          lastData
        ) {
          const video =
            extractVideoValue(
              lastData
            );

          if (video) {
            finishSuccess(
              video
            );
          }
        }
      };

      // ------------------------------------------------------
      // EVENEMENT STATUS
      // ------------------------------------------------------

      if (
        typeof job.on ===
        "function"
      ) {
        job.on(
          "status",
          (status) => {
            printStatus(
              status
            );
          }
        );

        // Données finales.
        job.on(
          "data",
          (data) => {
            if (finished) {
              return;
            }

            lastData = data;

            console.log(
              "[WAN DATA] Données reçues."
            );

            const video =
              extractVideoValue(
                data
              );

            if (video) {
              finishSuccess(
                video
              );
            }
          }
        );

        // Erreur client.
        job.on(
          "error",
          (error) => {
            finishError(
              error instanceof Error
                ? error
                : new Error(
                    String(error)
                  )
            );
          }
        );
      }

      // ------------------------------------------------------
      // POLLING STATUS
      // ------------------------------------------------------
      //
      // La documentation JS expose les événements status.
      // Certaines versions du client exposent aussi status().
      // On utilise status() si disponible pour avoir une
      // surveillance supplémentaire.
      //

      const pollStatus =
        async () => {
          if (finished) {
            return;
          }

          try {
            if (
              typeof job.status ===
              "function"
            ) {
              const status =
                await job.status();

              printStatus(
                status
              );
            }
          } catch (error) {
            // Ne pas interrompre automatiquement
            // le job uniquement parce qu'un polling
            // de statut échoue.
            console.log(
              "[WAN STATUS] Polling indisponible:",
              error.message
            );
          }
        };

      statusTimer =
        setInterval(
          pollStatus,
          WAN_STATUS_INTERVAL_MS
        );

      // Premier statut immédiatement.
      pollStatus();

      // ------------------------------------------------------
      // TIMEOUT REEL
      // ------------------------------------------------------

      timeoutTimer =
        setTimeout(
          async () => {
            if (finished) {
              return;
            }

            const elapsed =
              Math.round(
                (Date.now() -
                  startedAt) /
                  1000
              );

            console.error(
              `Timeout Wan 2.2 après ${elapsed}s.`
            );

            console.error(
              "Dernier statut:",
              lastStatus
            );

            // IMPORTANT :
            // On marque la requête comme terminée
            // AVANT l'annulation pour empêcher
            // de nouveaux traitements.
            finished = true;

            cleanup();

            try {
              if (
                typeof job.cancel ===
                "function"
              ) {
                console.log(
                  "Tentative d'annulation du job Wan 2.2..."
                );

                await job.cancel();

                console.log(
                  "Demande d'annulation envoyée."
                );
              }
            } catch (cancelError) {
              console.error(
                "Erreur pendant l'annulation:",
                cancelError?.message ||
                  cancelError
              );
            }

            reject(
              new Error(
                `Le Space Wan 2.2 n'a pas terminé après ${Math.round(
                  WAN_TIMEOUT_MS /
                    60000
                )} minutes. Le job a été annulé.`
              )
            );
          },
          WAN_TIMEOUT_MS
        );
    }
  );
}

// ============================================================
// GENERATION WAN 2.2
// ============================================================

async function generateWanVideo({
  imageUrl,
  prompt,
  duration,
  steps,
  guidanceScale,
  guidanceScale2,
  seed,
  randomizeSeed,
}) {
  if (!WAN_ENABLED) {
    throw new Error(
      "HF_TOKEN n'est pas configuré sur Railway. Wan 2.2 est désactivé."
    );
  }

  console.log(
    "======================================"
  );

  console.log(
    "DEMANDE VIDEO WAN 2.2"
  );

  console.log(
    "======================================"
  );

  console.log(
    "Image:",
    imageUrl
  );

  console.log(
    "Prompt:",
    prompt
  );

  console.log(
    "Duration:",
    duration
  );

  console.log(
    "Steps:",
    steps
  );

  console.log(
    "Connexion à Hugging Face Space:",
    HF_SPACE
  );

  // ----------------------------------------------------------
  // CONNEXION
  // ----------------------------------------------------------

  const client =
    await Client.connect(
      HF_SPACE,
      {
        token: HF_TOKEN,

        // Demande explicitement les événements
        // status et data.
        events: [
          "status",
          "data",
        ],
      }
    );

  console.log(
    "Connexion Hugging Face réussie."
  );

  // ----------------------------------------------------------
  // IMAGE
  // ----------------------------------------------------------

  const imageBuffer =
    await readLocalImageFromUrl(
      imageUrl
    );

  console.log(
    "Image prête."
  );

  console.log(
    "Soumission du job Wan 2.2..."
  );

  // ----------------------------------------------------------
  // SUBMIT
  // ----------------------------------------------------------
  //
  // On utilise submit() et non predict()
  // afin de récupérer un Job surveillable.
  //

  const job =
    client.submit(
      "/generate_video",
      [
        imageBuffer,
        prompt,

        steps,

        "blurry, low quality, distorted face, deformed body, extra limbs, bad anatomy, text, watermark",

        duration,

        guidanceScale,

        guidanceScale2,

        seed,

        randomizeSeed,
      ]
    );

  console.log(
    "Job Wan 2.2 soumis."
  );

  console.log(
    "Surveillance de la file..."
  );

  // ----------------------------------------------------------
  // ATTENTE
  // ----------------------------------------------------------

  const result =
    await waitForWanJob(
      job
    );

  if (!result?.video) {
    throw new Error(
      "Wan 2.2 a terminé mais aucune vidéo n'a été retournée."
    );
  }

  console.log(
    "======================================"
  );

  console.log(
    "VIDEO WAN 2.2 TERMINÉE"
  );

  console.log(
    "Video:",
    result.video
  );

  console.log(
    "======================================"
  );

  return result;
}

// ============================================================
// ROUTE RACINE
// ============================================================

app.get(
  "/",
  (_req, res) => {
    res.json({
      success: true,

      message:
        "Cinema AI backend fonctionne.",

      wan2Configured:
        WAN_ENABLED,

      wan2Space:
        HF_SPACE,
    });
  }
);

// ============================================================
// HEALTH
// ============================================================

app.get(
  "/api/health",
  (_req, res) => {
    res.json({
      success: true,

      message:
        "Backend Cinema AI opérationnel.",

      wan2Configured:
        WAN_ENABLED,

      wan2Space:
        HF_SPACE,
    });
  }
);

// ============================================================
// UPLOAD IMAGE
// ============================================================

app.post(
  "/api/assets",
  upload.single("image"),
  (req, res) => {
    try {
      console.log(
        "=== UPLOAD IMAGE ==="
      );

      console.log(
        "File:",
        req.file
          ? {
              originalname:
                req.file
                  .originalname,

              mimetype:
                req.file
                  .mimetype,

              size:
                req.file.size,

              filename:
                req.file
                  .filename,
            }
          : null
      );

      if (!req.file) {
        return res.status(400).json({
          success: false,

          message:
            "Aucun fichier image reçu.",
        });
      }

      const url =
        `${req.protocol}://${req.get(
          "host"
        )}/uploads/${encodeURIComponent(
          req.file.filename
        )}`;

      const asset = {
        id:
          `${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 10)}`,

        name:
          req.file.originalname,

        filename:
          req.file.filename,

        mimetype:
          req.file.mimetype,

        size:
          req.file.size,

        url,

        storageUrl:
          url,

        uploaded:
          true,
      };

      res.json({
        success: true,

        message:
          "Image reçue correctement.",

        asset,
      });
    } catch (error) {
      console.error(
        "Erreur /api/assets:",
        error
      );

      res.status(500).json({
        success: false,

        message:
          "Erreur pendant la réception de l'image.",

        error:
          error.message,
      });
    }
  }
);

// ============================================================
// TEST DONNEES SCENE
// ============================================================

app.post(
  "/api/generate",
  (req, res) => {
    try {
      const sceneData =
        req.body;

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
        "=== DONNÉES DE SCÈNE REÇUES ==="
      );

      console.log(
        "Scene ID:",
        sceneData.scene.id
      );

      console.log(
        "Personnages:",
        sceneData
          .characters
          ?.length || 0
      );

      console.log(
        "Lieux:",
        sceneData
          .locations
          ?.length || 0
      );

      console.log(
        "Mouvements:",
        sceneData
          .movements
          ?.length || 0
      );

      console.log(
        "Reference images:",
        sceneData
          .referenceImages
          ?.length || 0
      );

      console.log(
        "================================"
      );

      res.json({
        success: true,

        message:
          "Données de scène reçues correctement.",

        received: {
          sceneId:
            sceneData.scene.id,

          characters:
            sceneData
              .characters
              ?.length || 0,

          locations:
            sceneData
              .locations
              ?.length || 0,

          movements:
            sceneData
              .movements
              ?.length || 0,

          referenceImages:
            sceneData
              .referenceImages
              ?.length || 0,
        },
      });
    } catch (error) {
      console.error(
        "Erreur /api/generate:",
        error
      );

      res.status(500).json({
        success: false,

        message:
          "Erreur pendant le traitement de la scène.",

        error:
          error.message,
      });
    }
  }
);

// ============================================================
// GENERATION VIDEO
// ============================================================

app.post(
  "/api/generate-video",
  async (req, res) => {
    try {
      const sceneData =
        req.body;

      if (!sceneData) {
        return res.status(400).json({
          success: false,

          message:
            "Données de génération manquantes.",
        });
      }

      // ------------------------------------------------------
      // IMAGE
      // ------------------------------------------------------

      const imageUrl =
        sceneData.imageUrl ||
        findFirstImage(
          sceneData
        );

      if (!imageUrl) {
        return res.status(400).json({
          success: false,

          message:
            "Aucune image de référence disponible pour Wan 2.2.",
        });
      }

      if (
        String(
          imageUrl
        ).startsWith("blob:")
      ) {
        return res.status(400).json({
          success: false,

          message:
            "Une URL blob: a été reçue. L'image doit d'abord être uploadée sur le backend.",
        });
      }

      // ------------------------------------------------------
      // PROMPT
      // ------------------------------------------------------

      const prompt =
        sceneData.prompt ||
        buildVideoPrompt(
          sceneData
        );

      // ------------------------------------------------------
      // PARAMETRES
      // ------------------------------------------------------

      const duration =
        clamp(
          safeNumber(
            sceneData.duration,
            5
          ),
          1,
          5
        );

      const steps =
        clamp(
          Math.round(
            safeNumber(
              sceneData.steps,
              6
            )
          ),
          1,
          20
        );

      const guidanceScale =
        safeNumber(
          sceneData.guidanceScale,
          1
        );

      const guidanceScale2 =
        safeNumber(
          sceneData.guidanceScale2,
          1
        );

      const seed =
        Math.round(
          safeNumber(
            sceneData.seed,
            42
          )
        );

      const randomizeSeed =
        sceneData.randomizeSeed !==
        false;

      // ------------------------------------------------------
      // GENERATION
      // ------------------------------------------------------

      const result =
        await generateWanVideo({
          imageUrl,

          prompt,

          duration,

          steps,

          guidanceScale,

          guidanceScale2,

          seed,

          randomizeSeed,
        });

      // ------------------------------------------------------
      // REPONSE
      // ------------------------------------------------------

      res.json({
        success: true,

        message:
          "Vidéo Wan 2.2 générée avec succès.",

        video:
          result.video,

        status:
          result.status,
      });
    } catch (error) {
      console.error(
        "======================================"
      );

      console.error(
        "ERREUR GENERATION WAN 2.2"
      );

      console.error(
        "======================================"
      );

      console.error(
        error
      );

      res.status(500).json({
        success: false,

        message:
          error?.message ||
          "Erreur pendant la génération vidéo Wan 2.2.",

        error:
          error?.message ||
          String(error),
      });
    }
  }
);

// ============================================================
// GESTION ERREURS
// ============================================================

app.use(
  (
    error,
    _req,
    res,
    _next
  ) => {
    console.error(
      "ERREUR SERVEUR:",
      error
    );

    if (
      error instanceof
      multer.MulterError
    ) {
      return res.status(400).json({
        success: false,

        message:
          "Erreur Multer lors de l'envoi du fichier.",

        error:
          error.message,

        code:
          error.code,
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

// ============================================================
// DEMARRAGE
// ============================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Cinema AI backend démarré sur le port ${PORT}`
    );

    console.log(
      "Wan 2.2 configuré:",
      WAN_ENABLED
    );

    console.log(
      "Wan 2.2 Space:",
      HF_SPACE
    );

    console.log(
      "Wan 2.2 timeout:",
      `${WAN_TIMEOUT_MS / 60000} minutes`
    );
  }
);
