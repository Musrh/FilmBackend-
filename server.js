Gmail, c'est encore mieux dans l'appli
Une messagerie sécurisée, rapide et organisée
Ouvrir
Decoupage
M
MUSTAPHA HOME
à moi
il y a 0 minuteDétails
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

/*
 * IMPORTANT
 *
 * Wan 2.2 utilisé actuellement accepte environ 5 secondes
 * par génération.
 *
 * Cela ne signifie PAS que Cinema AI doit limiter les scènes
 * à 5 secondes.
 *
 * Une scène de 10 secondes sera plus tard découpée en :
 *
 *   [5, 5]
 *
 * Une scène de 15 secondes :
 *
 *   [5, 5, 5]
 *
 * etc.
 */
const WAN_MAX_SEGMENT_DURATION = 5;

const MAX_UPLOAD_SIZE = 500 * 1024 * 1024;

const uploadsDir = path.join(__dirname, "uploads");

fs.mkdirSync(uploadsDir, {
  recursive: true,
});

// Railway est derrière un proxy.
app.set("trust proxy", 1);

app.use(
  cors({
    origin: "*",
  }),
);

app.use(
  express.json({
    limit: "50mb",
  }),
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "50mb",
  }),
);

app.use("/uploads", express.static(uploadsDir));


// ============================================================
// MULTER
// ============================================================

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    callback(null, uploadsDir);
  },

  filename: (_req, file, callback) => {
    const timestamp = Date.now();

    const random = Math.random()
      .toString(36)
      .substring(2, 8);

    const safeName = file.originalname.replace(
      /[^a-zA-Z0-9._-]/g,
      "-",
    );

    callback(
      null,
      `${timestamp}-${random}-${safeName}`,
    );
  },
});

const upload = multer({
  storage,

  limits: {
    fileSize: MAX_UPLOAD_SIZE,
  },
});


// ============================================================
// UTILITAIRES
// ============================================================

function formatEta(eta) {
  if (
    eta === null ||
    eta === undefined ||
    !Number.isFinite(Number(eta))
  ) {
    return "?";
  }

  const seconds = Number(eta);

  return seconds < 60
    ? `${Math.round(seconds)}s`
    : `${Math.round(seconds / 60)}min`;
}


function numberOr(value, fallback) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return fallback;
  }

  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}


function booleanOr(value, fallback) {
  if (typeof value === "boolean") {
    return value;
  }

  if (value === "true" || value === 1 || value === "1") {
    return true;
  }

  if (value === "false" || value === 0 || value === "0") {
    return false;
  }

  return fallback;
}


// ============================================================
// DUREE
// ============================================================

/*
 * Cette fonction sera utilisée lors de la prochaine étape
 * pour découper une scène longue en segments compatibles
 * avec Wan 2.2.
 *
 * Exemple :
 *
 * 5  -> [5]
 * 10 -> [5, 5]
 * 15 -> [5, 5, 5]
 * 12 -> [5, 5, 2]
 */
function splitDurationIntoSegments(
  totalDuration,
  maxSegmentDuration = WAN_MAX_SEGMENT_DURATION,
) {
  const total = Math.max(
    Number(totalDuration) || 5,
    1,
  );

  const segments = [];

  let remaining = total;

  while (remaining > 0) {
    const duration = Math.min(
      remaining,
      maxSegmentDuration,
    );

    segments.push(duration);

    remaining -= duration;
  }

  return segments;
}


// ============================================================
// EXTRACTION RESULTAT WAN / GRADIO
// ============================================================

function extractVideoValue(data) {
  if (
    data === null ||
    data === undefined
  ) {
    return null;
  }

  /*
   * Tableau :
   *
   * [
   *   {...},
   *   {...}
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
   * Chaîne :
   *
   * https://...
   */
  if (typeof data === "string") {
    const value = data.trim();

    if (
      value.startsWith("http://") ||
      value.startsWith("https://")
    ) {
      return value;
    }

    return null;
  }


  /*
   * Objet Gradio.
   *
   * On regarde plusieurs propriétés possibles.
   */
  if (
    typeof data === "object"
  ) {
    const possibleKeys = [
      "video",
      "url",
      "path",
      "file",
      "value",
      "data",
      "output",
    ];

    for (const key of possibleKeys) {
      if (
        data[key] !== undefined &&
        data[key] !== null
      ) {
        const result = extractVideoValue(
          data[key],
        );

        if (result) {
          return result;
        }
      }
    }
  }

  return null;
}


// ============================================================
// NORMALISATION IMAGE
// ============================================================

function normalizeImageUrl(imageUrl) {
  if (
    !imageUrl ||
    typeof imageUrl !== "string"
  ) {
    return null;
  }

  if (
    /^https?:\/\//i.test(imageUrl)
  ) {
    return imageUrl;
  }

  if (
    imageUrl.startsWith("/uploads/")
  ) {
    return imageUrl;
  }

  if (
    imageUrl.startsWith("uploads/")
  ) {
    return `/${imageUrl}`;
  }

  return imageUrl;
}


// ============================================================
// RECHERCHE IMAGE SCENE
// ============================================================

function findFirstImage(sceneData) {
  if (
    !sceneData ||
    typeof sceneData !== "object"
  ) {
    return null;
  }


  if (sceneData.imageUrl) {
    return normalizeImageUrl(
      sceneData.imageUrl,
    );
  }


  if (sceneData.image) {
    return normalizeImageUrl(
      sceneData.image,
    );
  }


  const referenceUrl = (image) => {
    if (typeof image === "string") {
      return normalizeImageUrl(image);
    }

    if (
      !image ||
      typeof image !== "object"
    ) {
      return null;
    }

    return normalizeImageUrl(
      image.storageUrl ||
        image.url,
    );
  };


  /*
   * Personnages + lieux
   */
  for (const group of [
    sceneData.characters,
    sceneData.locations,
  ]) {
    if (!Array.isArray(group)) {
      continue;
    }

    for (const item of group) {
      if (!item) {
        continue;
      }

      /*
       * Nouveau format :
       *
       * imageReferences: [...]
       */
      if (
        Array.isArray(
          item.imageReferences,
        )
      ) {
        for (
          const image of item.imageReferences
        ) {
          const url = referenceUrl(image);

          if (url) {
            return url;
          }
        }
      }

      /*
       * Compatibilité ancien format.
       */
      const directUrl =
        normalizeImageUrl(
          item.imageUrl ||
            item.image,
        );

      if (directUrl) {
        return directUrl;
      }
    }
  }


  /*
   * Images de référence de la scène.
   */
  for (
    const image of sceneData.referenceImages || []
  ) {
    const url = referenceUrl(image);

    if (url) {
      return url;
    }
  }


  /*
   * Images du style visuel.
   */
  for (
    const image of sceneData.visualStyle?.images || []
  ) {
    const url = referenceUrl(image);

    if (url) {
      return url;
    }
  }


  return null;
}


// ============================================================
// PROMPT VIDEO
// ============================================================

function buildVideoPrompt(sceneData) {
  if (
    !sceneData ||
    typeof sceneData !== "object"
  ) {
    return "Create a cinematic realistic video.";
  }

  const parts = [];


  if (sceneData.title) {
    parts.push(
      `Scene title: ${sceneData.title}`,
    );
  }


  if (sceneData.description) {
    parts.push(
      `Scene description: ${sceneData.description}`,
    );
  }


  if (sceneData.action) {
    parts.push(
      `Action and staging: ${sceneData.action}`,
    );
  }


  /*
   * PERSONNAGES
   */
  if (
    Array.isArray(sceneData.characters)
  ) {
    const characters =
      sceneData.characters
        .filter(Boolean)
        .map((character) => {
          const name =
            character.name ||
            "character";

          return character.description
            ? `${name}: ${character.description}`
            : name;
        })
        .join(", ");

    if (characters) {
      parts.push(
        `Characters: ${characters}`,
      );
    }
  }


  /*
   * LIEUX
   */
  if (
    Array.isArray(sceneData.locations)
  ) {
    const locations =
      sceneData.locations
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

    if (locations) {
      parts.push(
        `Locations: ${locations}`,
      );
    }
  }


  /*
   * MOUVEMENTS
   */
  if (
    Array.isArray(sceneData.movements)
  ) {
    const movements =
      sceneData.movements
        .filter(Boolean)
        .map((movement) => {
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
        `Movement sequence: ${movements}`,
      );
    }
  }


  /*
   * DIALOGUE
   *
   * Pour l'instant le dialogue sert au contexte
   * visuel.
   *
   * Le TTS/audio sera ajouté ensuite.
   */
  if (sceneData.dialogue) {
    parts.push(
      `Dialogue context: ${sceneData.dialogue}`,
    );
  }


  /*
   * STYLE VISUEL
   */
  if (sceneData.visualStyle) {
    const style =
      typeof sceneData.visualStyle === "string"
        ? sceneData.visualStyle
        : sceneData.visualStyle.text || "";

    if (style) {
      parts.push(
        `Visual style: ${style}`,
      );
    }
  }


  parts.push(
    "Cinematic realistic video, natural human movement, realistic facial expressions, realistic body proportions, coherent environment, cinematic lighting, subtle camera movement, consistent characters and locations, high visual quality.",
  );


  return parts.join("\n\n");
}


// ============================================================
// CHEMIN LOCAL UPLOAD
// ============================================================

function resolveLocalUploadPath(imageUrl) {
  const relativePath =
    imageUrl.replace(/^\/+/, "");

  const resolvedPath = path.resolve(
    __dirname,
    relativePath,
  );

  const resolvedUploadsDir =
    `${path.resolve(uploadsDir)}${path.sep}`;

  if (
    resolvedPath !==
      path.resolve(uploadsDir) &&
    !resolvedPath.startsWith(
      resolvedUploadsDir,
    )
  ) {
    throw new Error(
      "Le chemin de l’image n’est pas autorisé.",
    );
  }

  return resolvedPath;
}


// ============================================================
// UPLOAD ASSETS
// ============================================================

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
       * Cinema AI envoie actuellement :
       *
       * formData.append("image", blob, filename)
       *
       * Mais on accepte aussi "file".
       */

      const uploadedFile =
        req.files?.image?.[0] ||
        req.files?.file?.[0];

      if (!uploadedFile) {
        console.error(
          "Aucun fichier reçu dans /api/assets.",
        );

        console.error(
          "Champs reçus:",
          Object.keys(req.body || {}),
        );

        return res.status(400).json({
          success: false,
          message:
            "Aucun fichier image reçu.",
        });
      }


      const publicUrl =
        `${req.protocol}://${req.get(
          "host",
        )}/uploads/${encodeURIComponent(
          uploadedFile.filename,
        )}`;


      console.log(
        "==========================================",
      );

      console.log(
        "ASSET UPLOADÉ",
      );

      console.log(
        "Nom:",
        uploadedFile.originalname,
      );

      console.log(
        "Fichier:",
        uploadedFile.filename,
      );

      console.log(
        "Taille:",
        uploadedFile.size,
      );

      console.log(
        "URL:",
        publicUrl,
      );

      console.log(
        "==========================================",
      );


      return res.json({
        success: true,

        message:
          "Image reçue correctement.",

        asset: {
          id:
            `${Date.now()}-${Math.random()
              .toString(36)
              .slice(2, 10)}`,

          name:
            uploadedFile.originalname,

          filename:
            uploadedFile.filename,

          mimetype:
            uploadedFile.mimetype,

          size:
            uploadedFile.size,

          url:
            publicUrl,

          storageUrl:
            publicUrl,

          uploaded: true,
        },
      });
    } catch (error) {
      console.error(
        "Erreur /api/assets:",
      );

      console.error(error);

      return res.status(500).json({
        success: false,

        message:
          error?.message ||
          "Erreur serveur pendant l'upload.",
      });
    }
  },
);


// ============================================================
// ROOT
// ============================================================

app.get("/", (_req, res) => {
  res.json({
    success: true,

    service:
      "Cinema AI Backend",

    status:
      "online",

    wanSpace:
      HF_SPACE,

    wanTimeoutMinutes:
      WAN_TIMEOUT_MS / 60000,

    wanMaxSegmentDuration:
      WAN_MAX_SEGMENT_DURATION,
  });
});


// ============================================================
// HEALTH
// ============================================================

app.get(
  "/api/health",
  (_req, res) => {
    res.json({
      success: true,

      status:
        "ok",

      hfConfigured:
        Boolean(HF_TOKEN),

      wanSpace:
        HF_SPACE,

      wanMaxSegmentDuration:
        WAN_MAX_SEGMENT_DURATION,
    });
  },
);


// ============================================================
// TEST HUGGING FACE
// ============================================================

app.get(
  "/api/test-huggingface",
  async (_req, res) => {
    try {
      if (!HF_TOKEN) {
        return res.status(500).json({
          success: false,

          error:
            "HF_TOKEN n'est pas configuré dans l'environnement.",
        });
      }


      await Client.connect(
        HF_SPACE,
        {
          token:
            HF_TOKEN,

          events: [
            "data",
            "status",
          ],
        },
      );


      return res.json({
        success: true,

        message:
          "Connexion Hugging Face réussie.",

        space:
          HF_SPACE,
      });
    } catch (error) {
      console.error(
        "Erreur Hugging Face:",
        error,
      );

      return res.status(500).json({
        success: false,

        error:
          error?.message ||
          "Impossible de se connecter à Hugging Face.",
      });
    }
  },
);


// ============================================================
// ATTENTE JOB WAN
// ============================================================

async function waitForWanJob(job) {
  const startedAt = Date.now();

  return new Promise(
    (resolve, reject) => {
      let settled = false;

      let finalVideo = null;

      let lastStatus = null;

      let dataReceived = false;

      let graceTimer = null;


      let timeoutTimer;


      const finish = (
        fn,
        value,
      ) => {
        if (settled) {
          return;
        }

        settled = true;

        clearTimeout(
          timeoutTimer,
        );

        clearTimeout(
          graceTimer,
        );

        fn(value);
      };


      /*
       * Timeout global.
       */
      timeoutTimer =
        setTimeout(
          () => {
            const elapsed =
              Math.round(
                (Date.now() -
                  startedAt) /
                  1000,
              );

            console.error(
              `Timeout Wan 2.2 après ${elapsed}s.`,
            );


            try {
              if (
                typeof job?.cancel ===
                "function"
              ) {
                Promise.resolve(
                  job.cancel(),
                ).catch(() => {});
              }
            } catch {}


            finish(
              reject,

              new Error(
                `Le Space Wan 2.2 n'a pas terminé après ${Math.round(
                  WAN_TIMEOUT_MS /
                    60000,
                )} minutes. Le job a été annulé.`,
              ),
            );
          },
          WAN_TIMEOUT_MS,
        );


      /*
       * Gradio fournit normalement un AsyncIterator.
       *
       * On utilise next() manuellement plutôt que
       * "for await ... return".
       */
      const iterator =
        job &&
        typeof job[
          Symbol.asyncIterator
        ] === "function"
          ? job[
              Symbol.asyncIterator
            ]()
          : job;


      (async () => {
        try {
          while (!settled) {
            const {
              value: message,
              done,
            } =
              await iterator.next();


            if (done) {
              break;
            }


            if (!message) {
              continue;
            }


            /*
             * STATUS
             */
            if (
              message.type ===
              "status"
            ) {
              lastStatus =
                message;


              const stage =
                message.stage ||
                message.status ||
                "unknown";


              const elapsed =
                Math.round(
                  (Date.now() -
                    startedAt) /
                    1000,
                );


              console.log(
                `[WAN STATUS] stage=${stage} | position=${
                  message.position ??
                  "?"
                } | queue=${
                  message.size ??
                  message.queue_size ??
                  "?"
                } | ETA=${formatEta(
                  message.eta,
                )} | elapsed=${elapsed}s`,
              );


              if (
                stage === "error"
              ) {
                return finish(
                  reject,

                  new Error(
                    message.message ||
                      message.code ||
                      "Le Space Wan 2.2 a signalé une erreur.",
                  ),
                );
              }


              /*
               * Wan annonce "complete".
               *
               * Si la data est déjà arrivée,
               * on termine immédiatement.
               */
              if (
                stage ===
                "complete"
              ) {
                if (finalVideo) {
                  console.log(
                    "[WAN] Résultat complet reçu.",
                  );

                  return finish(
                    resolve,
                    {
                      video:
                        finalVideo,

                      status:
                        message,
                    },
                  );
                }


                /*
                 * Il arrive que le status complete
                 * arrive légèrement avant data.
                 *
                 * On donne une courte fenêtre
                 * au dernier événement data.
                 */
                graceTimer =
                  setTimeout(
                    () => {
                      if (
                        finalVideo
                      ) {
                        finish(
                          resolve,
                          {
                            video:
                              finalVideo,

                            status:
                              lastStatus,
                          },
                        );

                        return;
                      }


                      finish(
                        reject,

                        new Error(
                          dataReceived
                            ? "Wan 2.2 a terminé, mais la donnée reçue ne contient pas d'URL vidéo exploitable."
                            : "Wan 2.2 a terminé sans renvoyer de vidéo.",
                        ),
                      );
                    },
                    15000,
                  );
              }
            }


            /*
             * DATA
             */
            if (
              message.type ===
              "data"
            ) {
              console.log(
                "[WAN DATA] Résultat reçu.",
              );


              dataReceived = true;


              /*
               * On garde le résultat brut
               * dans les logs pour pouvoir
               * diagnostiquer Gradio.
               */
              try {
                console.log(
                  "[WAN DATA] Brut:",
                  JSON.stringify(
                    message.data,
                  ).slice(
                    0,
                    3000,
                  ),
                );
              } catch {
                console.log(
                  "[WAN DATA] Impossible de sérialiser la donnée brute.",
                );
              }


              const video =
                extractVideoValue(
                  message.data,
                );


              if (video) {
                finalVideo =
                  video;


                console.log(
                  "[WAN DATA] URL vidéo:",
                  video,
                );


                /*
                 * Une vraie URL vidéo est déjà disponible.
                 *
                 * On peut terminer sans attendre
                 * que l'iterator soit fermé.
                 */
                return finish(
                  resolve,
                  {
                    video:
                      finalVideo,

                    status:
                      lastStatus,
                  },
                );
              }


              console.log(
                "[WAN DATA] Aucune URL vidéo exploitable dans cette data.",
              );
            }
          }


          /*
           * Iterator terminé.
           */
          if (
            finalVideo
          ) {
            return finish(
              resolve,
              {
                video:
                  finalVideo,

                status:
                  lastStatus,
              },
            );
          }


          return finish(
            reject,

            new Error(
              "Le job Wan 2.2 est terminé mais aucune vidéo n'a été retournée.",
            ),
          );
        } catch (error) {
          finish(
            reject,
            error,
          );
        }
      })();
    },
  );
}


// ============================================================
// SAUVEGARDE VIDEO WAN
// ============================================================

async function saveVideoLocally(
  videoUrl,
  req,
) {
  if (
    !videoUrl ||
    typeof videoUrl !== "string"
  ) {
    throw new Error(
      "URL vidéo invalide.",
    );
  }


  /*
   * Si Wan retourne déjà une URL HTTP,
   * on la télécharge.
   */
  if (
    !/^https?:\/\//i.test(
      videoUrl,
    )
  ) {
    throw new Error(
      `Wan a retourné une référence vidéo non HTTP: ${videoUrl}`,
    );
  }


  const headers =
    HF_TOKEN
      ? {
          Authorization:
            `Bearer ${HF_TOKEN}`,
        }
      : {};


  const response =
    await fetch(
      videoUrl,
      {
        headers,
      },
    );


  if (!response.ok) {
    throw new Error(
      `Téléchargement vidéo impossible. HTTP ${response.status}`,
    );
  }


  const buffer =
    Buffer.from(
      await response.arrayBuffer(),
    );


  const filename =
    `${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}-wan.mp4`;


  fs.writeFileSync(
    path.join(
      uploadsDir,
      filename,
    ),
    buffer,
  );


  console.log(
    "Vidéo enregistrée:",
    filename,
    buffer.length,
    "bytes",
  );


  return (
    `${req.protocol}://${req.get(
      "host",
    )}/uploads/${filename}`
  );
}


// ============================================================
// GENERATION VIDEO
// ============================================================

app.post(
  "/api/generate-video",
  async (req, res) => {
    const startedAt =
      Date.now();


    try {
      if (!HF_TOKEN) {
        return res.status(500).json({
          success: false,

          error:
            "HF_TOKEN n'est pas configuré dans l'environnement.",
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


      /*
       * Cinema AI peut envoyer sceneData
       * ou scene.
       */
      const data =
        sceneData ||
        scene ||
        {};


      /*
       * Image de référence.
       */
      const finalImageUrl =
        normalizeImageUrl(
          imageUrl ||
            findFirstImage(data),
        );


      if (!finalImageUrl) {
        return res.status(400).json({
          success: false,

          error:
            "Aucune image de référence n'a été trouvée pour cette scène.",
        });
      }


      console.log(
        "==========================================",
      );

      console.log(
        "NOUVELLE GENERATION WAN",
      );

      console.log(
        "Image:",
        finalImageUrl,
      );

      console.log(
        "Durée scène demandée:",
        duration,
      );

      console.log(
        "==========================================",
      );


      /*
       * Téléchargement image.
       */
      let imageBuffer;


      if (
        /^https?:\/\//i.test(
          finalImageUrl,
        )
      ) {
        const imageResponse =
          await fetch(
            finalImageUrl,
          );


        if (!imageResponse.ok) {
          throw new Error(
            `Impossible de télécharger l'image. HTTP ${imageResponse.status}`,
          );
        }


        imageBuffer =
          Buffer.from(
            await imageResponse.arrayBuffer(),
          );


        console.log(
          "Image téléchargée:",
          imageBuffer.length,
          "bytes",
        );
      } else {
        const localPath =
          resolveLocalUploadPath(
            finalImageUrl,
          );


        if (
          !fs.existsSync(
            localPath,
          )
        ) {
          throw new Error(
            `Image introuvable: ${localPath}`,
          );
        }


        imageBuffer =
          fs.readFileSync(
            localPath,
          );


        console.log(
          "Image lue depuis le disque:",
          localPath,
        );
      }


      /*
       * Prompt.
       */
      const finalPrompt =
        prompt ||
        buildVideoPrompt(
          data,
        );


      /*
       * Paramètres Wan.
       */
      const finalSteps =
        numberOr(
          steps,
          4,
        );


      /*
       * IMPORTANT :
       *
       * Pour cette étape, on génère UN SEUL
       * segment Wan.
       *
       * Le segment est limité à 5 secondes.
       *
       * La durée globale de la scène pourra être
       * 10, 15, 20, 30... dans Cinema AI.
       *
       * La segmentation sera ajoutée ensuite.
       */
      const requestedDuration =
        Math.max(
          numberOr(
            duration,
            5,
          ),
          1,
        );


      const finalDuration =
        Math.min(
          requestedDuration,
          WAN_MAX_SEGMENT_DURATION,
        );


      if (
        requestedDuration >
        WAN_MAX_SEGMENT_DURATION
      ) {
        console.log(
          `Durée scène ${requestedDuration}s > ${WAN_MAX_SEGMENT_DURATION}s. Pour l'instant, un seul segment de ${finalDuration}s sera généré. La segmentation sera ajoutée à l'étape suivante.`,
        );
      }


      const finalGuidanceScale =
        numberOr(
          guidanceScale,
          1,
        );


      const finalGuidanceScale2 =
        numberOr(
          guidanceScale2,
          1,
        );


      const finalSeed =
        numberOr(
          seed,
          42,
        );


      const finalRandomizeSeed =
        booleanOr(
          randomizeSeed,
          false,
        );


      /*
       * Connexion Hugging Face.
       */
      console.log(
        "Connexion Hugging Face...",
      );


      const client =
        await Client.connect(
          HF_SPACE,
          {
            token:
              HF_TOKEN,

            events: [
              "data",
              "status",
            ],
          },
        );


      console.log(
        "Connexion Hugging Face réussie.",
      );


      /*
       * Soumission Wan.
       */
      console.log(
        "Soumission du job Wan 2.2...",
      );


      console.log(
        "Durée segment Wan:",
        finalDuration,
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
          ],
        );


      console.log(
        "Job Wan 2.2 soumis. Surveillance de la file...",
      );


      /*
       * Attente résultat.
       */
      const result =
        await waitForWanJob(
          job,
        );


      const elapsed =
        Math.round(
          (Date.now() -
            startedAt) /
            1000,
        );


      console.log(
        `Vidéo Wan 2.2 terminée après ${elapsed}s.`,
      );


      console.log(
        "URL vidéo:",
        result.video,
      );


      /*
       * Sauvegarde locale.
       */
      let publicVideo =
        result.video;


      try {
        publicVideo =
          await saveVideoLocally(
            result.video,
            req,
          );
      } catch (error) {
        console.error(
          "Copie locale échouée, URL Hugging Face renvoyée:",
          error?.message ||
            error,
        );
      }


      /*
       * Réponse frontend.
       */
      return res.json({
        success: true,

        /*
         * URL stable si la copie locale
         * a fonctionné.
         */
        video:
          publicVideo,

        videoUrl:
          publicVideo,

        /*
         * URL originale Wan.
         */
        originalVideoUrl:
          result.video,

        result: {
          video:
            publicVideo,

          status:
            result.status,

          /*
           * Durée réellement demandée à Wan
           * pour CE segment.
           */
          duration:
            finalDuration,

          /*
           * Durée globale de la scène
           * demandée par Cinema AI.
           */
          requestedSceneDuration:
            requestedDuration,

          elapsedSeconds:
            elapsed,

          segmented:
            requestedDuration >
            WAN_MAX_SEGMENT_DURATION,

          segments:
            splitDurationIntoSegments(
              requestedDuration,
            ),
        },
      });
    } catch (error) {
      const elapsed =
        Math.round(
          (Date.now() -
            startedAt) /
            1000,
        );


      console.error(
        "==========================================",
      );

      console.error(
        "ERREUR GENERATION WAN",
      );

      console.error(
        error,
      );

      console.error(
        "==========================================",
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
  },
);


// ============================================================
// ENDPOINT COMPATIBILITE
// ============================================================

app.post(
  "/api/generate",
  (req, res) => {
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
  },
);


// ============================================================
// GESTION ERREURS MULTER / EXPRESS
// ============================================================

app.use(
  (
    error,
    _req,
    res,
    _next,
  ) => {
    if (
      error instanceof
      multer.MulterError
    ) {
      console.error(
        "ERREUR MULTER:",
        error.code,
      );


      return res.status(400).json({
        success: false,

        message:
          `Erreur upload Multer: ${error.code}`,
      });
    }


    console.error(
      "ERREUR SERVEUR:",
      error,
    );


    return res.status(500).json({
      success: false,

      message:
        error?.message ||
        "Erreur serveur.",
    });
  },
);


// ============================================================
// DEMARRAGE
// ============================================================

app.listen(
  PORT,
  () => {
    console.log(
      "==========================================",
    );

    console.log(
      "Cinema AI Backend",
    );

    console.log(
      `Port: ${PORT}`,
    );

    console.log(
      `Wan 2.2 timeout: ${
        WAN_TIMEOUT_MS / 60000
      } minutes`,
    );

    console.log(
      `Hugging Face Space: ${HF_SPACE}`,
    );

    console.log(
      `HF_TOKEN configuré: ${
        HF_TOKEN
          ? "OUI"
          : "NON"
      }`,
    );

    console.log(
      `Wan max segment: ${WAN_MAX_SEGMENT_DURATION}s`,
    );

    console.log(
      "==========================================",
    );
  },
);
