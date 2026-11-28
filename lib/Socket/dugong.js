import crypto from "crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { proto } from "../../WAProto/index.js";
import {
  delay,
  generateMessageID,
  generateWAMessage,
  generateWAMessageContent,
  generateWAMessageFromContent,
  getUrlFromDirectPath,
  normalizeMessageContent,
  prepareWAMessageMedia,
} from "../Utils/index.js";
import {
  isJidGroup,
  isPnUser,
  jidNormalizedUser,
  STORIES_JID,
} from "../WABinary/index.js";
export class Dugong {
  constructor(waUploadToServer, relayMessageFn, config, sock) {
    this.relayMessage = relayMessageFn;
    this.waUploadToServer = waUploadToServer;
    this.config = config;
    this.sock = sock;
  }
  detectType(content) {
    if (content.requestPaymentMessage) return "PAYMENT";
    if (content.productMessage) return "PRODUCT";
    if (content.interactiveButtons) return "INTERACTIVE_BUTTONS";
    if (content.interactiveMessage?.carouselMessage) return "CAROUSEL";
    if (content.interactiveMessage) return "INTERACTIVE";
    if (content.albumMessage || content.album) return "ALBUM";
    if (content.eventMessage) return "EVENT";
    if (content.pollResultMessage) return "POLL_RESULT";
    if (content.groupStatusMessage) return "GROUP_STORY";
    return null;
  }
  async handlePayment(content, quoted) {
    const data = content.requestPaymentMessage;
    let notes = {};
    if (data.sticker?.stickerMessage) {
      notes = {
        stickerMessage: {
          ...data.sticker.stickerMessage,
          contextInfo: {
            stanzaId: quoted?.key?.id,
            participant: quoted?.key?.participant || content.sender,
            quotedMessage: quoted?.message,
          },
        },
      };
    } else if (data.note) {
      notes = {
        extendedTextMessage: {
          text: data.note,
          contextInfo: {
            stanzaId: quoted?.key?.id,
            participant: quoted?.key?.participant || content.sender,
            quotedMessage: quoted?.message,
          },
        },
      };
    }
    return {
      requestPaymentMessage: proto.Message.RequestPaymentMessage.fromObject({
        expiryTimestamp: data.expiry || 0,
        amount1000: data.amount || 0,
        currencyCodeIso4217: data.currency || "IDR",
        requestFrom: data.from || "0@s.whatsapp.net",
        noteMessage: notes,
        background: data.background ?? {
          id: "DEFAULT",
          placeholderArgb: 0xfff0f0f0,
        },
      }),
    };
  }
  async handleProduct(content, _jid, _quoted) {
    const {
      title,
      description,
      thumbnail,
      productId,
      retailerId,
      url,
      body = "",
      footer = "",
      buttons = [],
      priceAmount1000 = null,
      currencyCode = "IDR",
    } = content.productMessage;
    let productImage;
    if (Buffer.isBuffer(thumbnail)) {
      const { imageMessage } = await generateWAMessageContent(
        { image: thumbnail },
        { upload: this.waUploadToServer },
      );
      productImage = imageMessage;
    } else if (typeof thumbnail === "object" && thumbnail.url) {
      const { imageMessage } = await generateWAMessageContent(
        { image: { url: thumbnail.url } },
        { upload: this.waUploadToServer },
      );
      productImage = imageMessage;
    }
    return {
      viewOnceMessage: {
        message: {
          interactiveMessage: {
            body: { text: body },
            footer: { text: footer },
            header: {
              title,
              hasMediaAttachment: true,
              productMessage: {
                product: {
                  productImage,
                  productId,
                  title,
                  description,
                  currencyCode,
                  priceAmount1000,
                  retailerId,
                  url,
                  productImageCount: 1,
                },
                businessOwnerJid: "0@s.whatsapp.net",
              },
            },
            nativeFlowMessage: { buttons },
          },
        },
      },
    };
  }
  async handleInteractive(content, _jid, _quoted) {
    const {
      title,
      footer,
      thumbnail,
      image,
      video,
      document,
      mimetype,
      fileName,
      jpegThumbnail,
      contextInfo,
      externalAdReply,
      buttons = [],
      nativeFlowMessage,
      header,
    } = content.interactiveMessage;
    let media = null;
    let _mediaType = null;
    if (thumbnail) {
      media = await prepareWAMessageMedia(
        { image: { url: thumbnail } },
        { upload: this.waUploadToServer },
      );
      _mediaType = "image";
    } else if (image) {
      const src =
        typeof image === "object" && image.url
          ? { image: { url: image.url } }
          : { image };
      media = await prepareWAMessageMedia(src, {
        upload: this.waUploadToServer,
      });
      _mediaType = "image";
    } else if (video) {
      const src =
        typeof video === "object" && video.url
          ? { video: { url: video.url } }
          : { video };
      media = await prepareWAMessageMedia(src, {
        upload: this.waUploadToServer,
      });
      _mediaType = "video";
    } else if (document) {
      const docPayload = { document };
      if (jpegThumbnail) {
        docPayload.jpegThumbnail =
          typeof jpegThumbnail === "object" && jpegThumbnail.url
            ? { url: jpegThumbnail.url }
            : jpegThumbnail;
      }
      media = await prepareWAMessageMedia(docPayload, {
        upload: this.waUploadToServer,
      });
      if (fileName) media.documentMessage.fileName = fileName;
      if (mimetype) media.documentMessage.mimetype = mimetype;
      _mediaType = "document";
    }
    const interactiveMessage = {
      body: { text: title || "" },
      footer: { text: footer || "" },
    };
    if (buttons && buttons.length > 0) {
      interactiveMessage.nativeFlowMessage = { buttons };
      if (nativeFlowMessage) {
        interactiveMessage.nativeFlowMessage = {
          ...interactiveMessage.nativeFlowMessage,
          ...nativeFlowMessage,
        };
      }
    } else if (nativeFlowMessage) {
      interactiveMessage.nativeFlowMessage = nativeFlowMessage;
    }
    if (media) {
      interactiveMessage.header = {
        title: header || "",
        hasMediaAttachment: true,
        ...media,
      };
    } else {
      interactiveMessage.header = {
        title: header || "",
        hasMediaAttachment: false,
      };
    }
    const finalContextInfo = {};
    if (contextInfo) {
      Object.assign(finalContextInfo, {
        mentionedJid: contextInfo.mentionedJid || [],
        forwardingScore: contextInfo.forwardingScore || 0,
        isForwarded: contextInfo.isForwarded || false,
        ...contextInfo,
      });
    }
    if (externalAdReply) {
      finalContextInfo.externalAdReply = {
        title: externalAdReply.title || "",
        body: externalAdReply.body || "",
        mediaType: externalAdReply.mediaType || 1,
        thumbnailUrl: externalAdReply.thumbnailUrl || "",
        mediaUrl: externalAdReply.mediaUrl || "",
        sourceUrl: externalAdReply.sourceUrl || "",
        showAdAttribution: externalAdReply.showAdAttribution || false,
        renderLargerThumbnail: externalAdReply.renderLargerThumbnail || false,
        ...externalAdReply,
      };
    }
    if (Object.keys(finalContextInfo).length > 0) {
      interactiveMessage.contextInfo = finalContextInfo;
    }
    return { interactiveMessage };
  }
  async handleInteractiveButtons(content, _jid, _quoted) {
    const {
      text,
      caption,
      title,
      subtitle,
      footer,
      interactiveButtons,
      hasMediaAttachment,
      image,
      video,
      document,
      mimetype,
      jpegThumbnail,
      location,
      product,
      businessOwnerJid,
    } = content;
    const bodyText = text || caption || "";
    const buttons = interactiveButtons.map((btn) => ({
      name: btn.name,
      buttonParamsJson:
        typeof btn.buttonParamsJson === "string"
          ? btn.buttonParamsJson
          : JSON.stringify(btn.buttonParamsJson),
    }));
    let headerContent = {};
    let mediaAttached =
      typeof hasMediaAttachment === "boolean" ? hasMediaAttachment : false;
    if (image) {
      const src =
        typeof image === "object" && image.url
          ? { image: { url: image.url } }
          : { image };
      const uploaded = await prepareWAMessageMedia(src, {
        upload: this.waUploadToServer,
      });
      headerContent = { ...uploaded };
      mediaAttached =
        typeof hasMediaAttachment === "boolean" ? hasMediaAttachment : true;
    } else if (video) {
      const src =
        typeof video === "object" && video.url
          ? { video: { url: video.url } }
          : { video };
      const uploaded = await prepareWAMessageMedia(src, {
        upload: this.waUploadToServer,
      });
      headerContent = { ...uploaded };
      mediaAttached =
        typeof hasMediaAttachment === "boolean" ? hasMediaAttachment : true;
    } else if (document) {
      const docPayload =
        typeof document === "object" && document.url
          ? { document: { url: document.url } }
          : { document };
      if (mimetype) docPayload.mimetype = mimetype;
      const uploaded = await prepareWAMessageMedia(docPayload, {
        upload: this.waUploadToServer,
      });
      if (jpegThumbnail) {
        uploaded.documentMessage.jpegThumbnail =
          typeof jpegThumbnail === "string"
            ? Buffer.from(jpegThumbnail, "base64")
            : jpegThumbnail;
      }
      headerContent = { ...uploaded };
      mediaAttached =
        typeof hasMediaAttachment === "boolean" ? hasMediaAttachment : true;
    } else if (location) {
      headerContent = {
        locationMessage: {
          degreesLatitude:
            location.degressLatitude || location.degreesLatitude || 0,
          degreesLongitude:
            location.degressLongitude || location.degreesLongitude || 0,
          name: location.name || "",
        },
      };
      mediaAttached =
        typeof hasMediaAttachment === "boolean" ? hasMediaAttachment : true;
    } else if (product) {
      let productImage;
      if (product.productImage) {
        const imgSrc =
          typeof product.productImage === "object" && product.productImage.url
            ? { image: { url: product.productImage.url } }
            : { image: product.productImage };
        const uploaded = await prepareWAMessageMedia(imgSrc, {
          upload: this.waUploadToServer,
        });
        productImage = uploaded.imageMessage;
      }
      headerContent = {
        productMessage: {
          product: {
            productImage,
            productId: product.productId,
            title: product.title,
            description: product.description,
            currencyCode: product.currencyCode || "IDR",
            priceAmount1000: product.priceAmount1000,
            retailerId: product.retailerId,
            url: product.url,
            productImageCount: product.productImageCount || 1,
          },
          businessOwnerJid: businessOwnerJid || "0@s.whatsapp.net",
        },
      };
      mediaAttached =
        typeof hasMediaAttachment === "boolean" ? hasMediaAttachment : true;
    }
    const interactiveMessage = {
      body: { text: bodyText },
      footer: { text: footer || "" },
      header: {
        title: title || "",
        subtitle: subtitle || "",
        hasMediaAttachment: mediaAttached,
        ...headerContent,
      },
      nativeFlowMessage: { buttons },
    };
    return {
      viewOnceMessage: {
        message: {
          messageContextInfo: {
            deviceListMetadata: {},
            deviceListMetadataVersion: 2,
            messageSecret: crypto.randomBytes(32),
          },
          interactiveMessage,
        },
      },
    };
  }
  async handleCarousel(content, _jid, _quoted) {
    const { interactiveMessage } = content;
    const { body, footer, header, carouselMessage, contextInfo } =
      interactiveMessage;
    const processedCards = [];
    for (const card of carouselMessage.cards) {
      const cardMsg = {
        body: card.body || { text: "" },
        footer: card.footer || { text: "" },
        header: {
          title: card.header?.title || "",
          hasMediaAttachment: false,
        },
      };
      if (card.nativeFlowMessage) {
        cardMsg.nativeFlowMessage = card.nativeFlowMessage;
      }
      if (
        card.header?.imageMessage ||
        card.header?.videoMessage ||
        card.header?.documentMessage
      ) {
        let headerContent = {};
        let mediaAttached = true;
        if (card.header.imageMessage) {
          const url = card.header.imageMessage.url || card.header.imageMessage;
          const src =
            typeof url === "string" ? { image: { url } } : { image: url };
          const uploaded = await prepareWAMessageMedia(src, {
            upload: this.waUploadToServer,
          });
          headerContent = { ...uploaded };
        } else if (card.header.videoMessage) {
          const url = card.header.videoMessage.url || card.header.videoMessage;
          const src =
            typeof url === "string" ? { video: { url } } : { video: url };
          const uploaded = await prepareWAMessageMedia(src, {
            upload: this.waUploadToServer,
          });
          headerContent = { ...uploaded };
        } else if (card.header.documentMessage) {
          const url =
            card.header.documentMessage.url || card.header.documentMessage;
          const src =
            typeof url === "string" ? { document: { url } } : { document: url };
          const uploaded = await prepareWAMessageMedia(src, {
            upload: this.waUploadToServer,
          });
          headerContent = { ...uploaded };
        }
        cardMsg.header = {
          title: card.header?.title || "",
          hasMediaAttachment: mediaAttached,
          ...headerContent,
        };
      }
      processedCards.push(cardMsg);
    }
    const interactiveMsg = {
      body: body || { text: "" },
      footer: footer || { text: "" },
      header: header || { title: "", hasMediaAttachment: false },
      carouselMessage: {
        cards: processedCards,
        messageVersion: carouselMessage.messageVersion || 1,
        carouselCardType: carouselMessage.carouselCardType ?? 1,
      },
    };
    if (contextInfo) {
      interactiveMsg.contextInfo = contextInfo;
    }
    return {
      viewOnceMessage: {
        message: {
          messageContextInfo: {
            deviceListMetadata: {},
            deviceListMetadataVersion: 2,
            messageSecret: crypto.randomBytes(32),
          },
          interactiveMessage: interactiveMsg,
        },
      },
    };
  }
  async handleAlbum(content, jid, quoted) {
    const array = content.albumMessage || content.album;
    const ctxInfo = content.contextInfo || {};
    const album = await generateWAMessageFromContent(
      jid,
      {
        messageContextInfo: {
          messageSecret: crypto.randomBytes(32),
        },
        albumMessage: {
          expectedImageCount: array.filter((a) => "image" in a).length,
          expectedVideoCount: array.filter((a) => "video" in a).length,
        },
      },
      {
        userJid: jidNormalizedUser(this.sock.authState?.creds?.me?.id || ""),
        quoted,
        upload: this.waUploadToServer,
      },
    );
    await this.relayMessage(jid, album.message, {
      messageId: album.key.id,
    });
    for (let item of array) {
      if (ctxInfo && Object.keys(ctxInfo).length > 0 && !item.contextInfo) {
        item = { ...item, contextInfo: ctxInfo };
      }
      const img = await generateWAMessage(jid, item, {
        upload: this.waUploadToServer,
        userJid: jidNormalizedUser(this.sock.authState?.creds?.me?.id || ""),
      });
      img.message.messageContextInfo = {
        messageSecret: crypto.randomBytes(32),
        messageAssociation: {
          associationType: 1,
          parentMessageKey: album.key,
        },
      };
      await this.relayMessage(jid, img.message, {
        messageId: img.key.id,
      });
    }
    return album;
  }
  async handleEvent(content, jid, quoted) {
    const eventData = content.eventMessage;
    const msg = await generateWAMessageFromContent(
      jid,
      {
        viewOnceMessage: {
          message: {
            messageContextInfo: {
              deviceListMetadata: {},
              deviceListMetadataVersion: 2,
              messageSecret: crypto.randomBytes(32),
            },
            eventMessage: {
              isCanceled: eventData.isCanceled || false,
              name: eventData.name,
              description: eventData.description,
              location: eventData.location || {
                degreesLatitude: 0,
                degreesLongitude: 0,
                name: "Location",
              },
              joinLink: eventData.joinLink || "",
              startTime:
                typeof eventData.startTime === "string"
                  ? parseInt(eventData.startTime)
                  : eventData.startTime || Date.now(),
              endTime:
                typeof eventData.endTime === "string"
                  ? parseInt(eventData.endTime)
                  : eventData.endTime || Date.now() + 3600000,
              extraGuestsAllowed: eventData.extraGuestsAllowed !== false,
            },
          },
        },
      },
      {
        quoted,
        userJid: jidNormalizedUser(this.sock.authState?.creds?.me?.id || ""),
      },
    );
    await this.relayMessage(jid, msg.message, {
      messageId: msg.key.id,
    });
    return msg;
  }
  async handlePollResult(content, jid, quoted) {
    const pollData = content.pollResultMessage;
    const msg = await generateWAMessageFromContent(
      jid,
      {
        pollResultSnapshotMessage: {
          name: pollData.name,
          pollVotes: pollData.pollVotes.map((vote) => ({
            optionName: vote.optionName,
            optionVoteCount:
              typeof vote.optionVoteCount === "number"
                ? vote.optionVoteCount.toString()
                : vote.optionVoteCount,
          })),
        },
      },
      {
        quoted,
        userJid: jidNormalizedUser(this.sock.authState?.creds?.me?.id || ""),
      },
    );
    await this.relayMessage(jid, msg.message, {
      messageId: msg.key.id,
    });
    return msg;
  }
  async handleGroupStory(content, jid, _quoted, options = {}) {
    const storyData = content.groupStatusMessage;
    let waMsgContent;
    if (storyData.message) {
      waMsgContent = storyData;
    } else {
      waMsgContent = await generateWAMessageContent(storyData, {
        upload: this.waUploadToServer,
      });
    }
    const innerMsg = waMsgContent.message || waMsgContent;
    const msgKey = Object.keys(innerMsg).find(
      (k) => innerMsg[k] && typeof innerMsg[k] === "object",
    );
    if (msgKey) {
      innerMsg[msgKey].contextInfo = innerMsg[msgKey].contextInfo || {};
      innerMsg[msgKey].contextInfo.isGroupStatus = true;
      if (!innerMsg[msgKey].contextInfo.statusSourceType) {
        if (innerMsg.imageMessage)
          innerMsg[msgKey].contextInfo.statusSourceType = 0;
        else if (innerMsg.videoMessage)
          innerMsg[msgKey].contextInfo.statusSourceType = 1;
        else if (innerMsg.audioMessage)
          innerMsg[msgKey].contextInfo.statusSourceType = 3;
        else if (innerMsg.extendedTextMessage)
          innerMsg[msgKey].contextInfo.statusSourceType = 4;
      }
    }
    const finalMsg = {
      groupStatusMessageV2: {
        message: innerMsg,
      },
    };
    return await this.relayMessage(jid, finalMsg, {
      messageId: generateMessageID(),
    });
  }
  async sendStatusWhatsApp(content, jids = []) {
    const userJid = jidNormalizedUser(this.sock.authState.creds.me.id);
    const allUsers = new Set();
    allUsers.add(userJid);
    for (const id of jids) {
      if (isJidGroup(id)) {
        try {
          const metadata = await this.sock.groupMetadata(id);
          metadata.participants.forEach((p) =>
            allUsers.add(jidNormalizedUser(p.jid || p.phoneNumber || p.id)),
          );
        } catch (error) {
          this.config.logger.error(
            `Error getting metadata for group ${id}: ${error}`,
          );
        }
      } else if (isPnUser(id)) {
        allUsers.add(jidNormalizedUser(id));
      }
    }
    const uniqueUsers = Array.from(allUsers);
    const getRandomHexColor = () =>
      "#" +
      Math.floor(Math.random() * 16777215)
        .toString(16)
        .padStart(6, "0");
    const isMedia = content.image || content.video || content.audio;
    const isAudio = !!content.audio;
    const messageContent = { ...content };
    if (isMedia && !isAudio) {
      if (messageContent.text) {
        messageContent.caption = messageContent.text;
        delete messageContent.text;
      }
      delete messageContent.ptt;
      delete messageContent.font;
      delete messageContent.backgroundColor;
      delete messageContent.textColor;
    }
    if (isAudio) {
      delete messageContent.text;
      delete messageContent.caption;
      delete messageContent.font;
      delete messageContent.textColor;
    }
    const font = !isMedia
      ? content.font || Math.floor(Math.random() * 9)
      : undefined;
    const textColor = !isMedia
      ? content.textColor || getRandomHexColor()
      : undefined;
    const backgroundColor =
      !isMedia || isAudio
        ? content.backgroundColor || getRandomHexColor()
        : undefined;
    const ptt = isAudio
      ? typeof content.ptt === "boolean"
        ? content.ptt
        : true
      : undefined;
    const { getUrlInfo } = await import("../Utils/link-preview.js");
    const msg = await generateWAMessage(STORIES_JID, messageContent, {
      logger: this.config.logger,
      userJid,
      getUrlInfo: (text) =>
        getUrlInfo(text, {
          thumbnailWidth: this.config.linkPreviewImageThumbnailWidth,
          fetchOpts: { timeout: 3000, ...(this.config.options || {}) },
          logger: this.config.logger,
          uploadImage: this.config.generateHighQualityLinkPreview
            ? this.waUploadToServer
            : undefined,
        }),
      upload: this.waUploadToServer,
      mediaCache: this.config.mediaCache,
      options: this.config.options,
      font,
      textColor,
      backgroundColor,
      ptt,
    });
    await this.relayMessage(STORIES_JID, msg.message, {
      messageId: msg.key.id,
      statusJidList: uniqueUsers,
      additionalNodes: [
        {
          tag: "meta",
          attrs: {},
          content: [
            {
              tag: "mentioned_users",
              attrs: {},
              content: jids.map((jid) => ({
                tag: "to",
                attrs: { jid: jidNormalizedUser(jid) },
              })),
            },
          ],
        },
      ],
    });
    for (const id of jids) {
      try {
        const normalizedId = jidNormalizedUser(id);
        const isPrivate = isPnUser(normalizedId);
        const type = isPrivate
          ? "statusMentionMessage"
          : "groupStatusMentionMessage";
        const protocolMessage = {
          [type]: {
            message: {
              protocolMessage: {
                key: msg.key,
                type: 25,
              },
            },
          },
          messageContextInfo: {
            messageSecret: crypto.randomBytes(32),
          },
        };
        const statusMsg = await generateWAMessageFromContent(
          normalizedId,
          protocolMessage,
          {
            userJid: jidNormalizedUser(
              this.sock.authState?.creds?.me?.id || "",
            ),
          },
        );
        await this.relayMessage(normalizedId, statusMsg.message, {
          additionalNodes: [
            {
              tag: "meta",
              attrs: isPrivate
                ? { is_status_mention: "true" }
                : { is_group_status_mention: "true" },
            },
          ],
        });
        await delay(2000);
      } catch (error) {
        this.config.logger.error(`Error sending to ${id}: ${error}`);
      }
    }
    return msg;
  }
  // Audio sticker (eksperimental): WebP sticker + audio dikirim lewat field protobuf 134.
  // Butuh ffmpeg. audio & sticker boleh Buffer / path / URL.
  async sendStickerAudio(jid, { audio, sticker, ptt = true, maxSeconds = 300 } = {}, options = {}) {
    if (!audio) throw new Error("audio is required");
    const proto_ = proto;
    const varint = (n) => {
      const o = [];
      while (n > 127) {
        o.push((n % 128) | 128);
        n = Math.floor(n / 128);
      }
      o.push(n);
      return Buffer.from(o);
    };
    const ld = (f, body) =>
      Buffer.concat([varint(f * 8 + 2), varint(body.length), body]);
    const toBuf = async (src) => {
      if (Buffer.isBuffer(src)) return src;
      if (/^https?:\/\//i.test(src)) {
        const r = await fetch(src);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return Buffer.from(await r.arrayBuffer());
      }
      return readFile(src);
    };
    const runFFmpeg = (args, input) =>
      new Promise((resolve, reject) => {
        const p = spawn("ffmpeg", args);
        const out = [];
        let err = "";
        p.stdout.on("data", (d) => out.push(d));
        p.stderr.on("data", (d) => (err += d));
        p.on("error", reject);
        p.on("close", (code) => {
          if (code !== 0) return reject(new Error(err.slice(-500)));
          resolve(Buffer.concat(out));
        });
        p.stdin.on("error", () => {});
        p.stdin.end(input);
      });
    const toOpus = (input) =>
      runFFmpeg(
        ["-v", "error", "-i", "pipe:0", "-vn", "-map_metadata", "-1",
         "-t", String(maxSeconds), "-c:a", "libopus", "-b:a", "64k", "-ar", "48000", "-ac", "1",
         "-f", "ogg", "pipe:1"],
        input,
      );
    const toWebp = (input) =>
      runFFmpeg(
        ["-v", "error", "-i", "pipe:0", "-frames:v", "1", "-vf",
         "scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000",
         "-c:v", "libwebp", "-f", "webp", "pipe:1"],
        input,
      );
    // Durasi Ogg/Opus dari granule position halaman terakhir (48 kHz)
    const oggSeconds = (b) => {
      const i = b.lastIndexOf("OggS");
      if (i < 0 || i + 14 > b.length) return 0;
      const gp = Number(b.readBigUInt64LE(i + 6));
      return gp > 0 ? Math.max(1, Math.round(gp / 48000)) : 0;
    };
    // Waveform 64 titik (0-100) dari PCM; gagal -> undefined
    const makeWaveform = async (ogg) => {
      try {
        const pcm = await runFFmpeg(
          ["-v", "error", "-i", "pipe:0", "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1"],
          ogg,
        );
        const n = Math.floor(pcm.length / 2);
        if (n < 64) return undefined;
        const step = Math.floor(n / 64);
        const vals = [];
        for (let i = 0; i < 64; i++) {
          let sum = 0;
          for (let j = 0; j < step; j++) sum += Math.abs(pcm.readInt16LE((i * step + j) * 2));
          vals.push(sum / step);
        }
        const max = Math.max(...vals) || 1;
        return Buffer.from(vals.map((v) => Math.round((v / max) * 100)));
      } catch {
        return undefined;
      }
    };
    const parseWebp = (b) => {
      if (
        b.length < 30 ||
        b.toString("ascii", 0, 4) !== "RIFF" ||
        b.toString("ascii", 8, 12) !== "WEBP"
      )
        throw new Error("Invalid WebP");
      const c = b.toString("ascii", 12, 16);
      if (c === "VP8 ")
        return {
          width: b.readUInt16LE(26) & 0x3fff,
          height: b.readUInt16LE(28) & 0x3fff,
          isAnimated: false,
        };
      if (c === "VP8L")
        return {
          width: 1 + (b[21] | ((b[22] & 0x3f) << 8)),
          height: 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10)),
          isAnimated: false,
        };
      if (c === "VP8X")
        return {
          width: 1 + b.readUIntLE(24, 3),
          height: 1 + b.readUIntLE(27, 3),
          isAnimated: (b[20] & 2) !== 0,
        };
      throw new Error("Unsupported WebP chunk");
    };
    const HKDF = { audio: "WhatsApp Audio Keys", sticker: "WhatsApp Image Keys" };
    const upload = async (plain, kind) => {
      const mediaKey = crypto.randomBytes(32);
      const k = Buffer.from(
        crypto.hkdfSync("sha256", mediaKey, Buffer.alloc(32), HKDF[kind], 112),
      );
      const iv = k.subarray(0, 16);
      const cipher = crypto.createCipheriv("aes-256-cbc", k.subarray(16, 48), iv);
      const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
      const mac = crypto
        .createHmac("sha256", k.subarray(48, 80))
        .update(iv)
        .update(enc)
        .digest()
        .subarray(0, 10);
      const file = Buffer.concat([enc, mac]);
      const fileEncSha256 = crypto.createHash("sha256").update(file).digest();
      const res = await this.waUploadToServer(file, {
        fileEncSha256B64: fileEncSha256.toString("base64"),
        mediaType: kind,
      });
      if (!res?.directPath)
        throw new Error(`${kind} upload returned no directPath`);
      return {
        url: res.mediaUrl || `https://mmg.whatsapp.net${res.directPath}`,
        directPath: res.directPath,
        mediaKey,
        fileEncSha256,
        fileSha256: crypto.createHash("sha256").update(plain).digest(),
        fileLength: plain.length,
        mediaKeyTimestamp: Math.floor(Date.now() / 1000),
      };
    };

    const audioInput = Buffer.from(await toBuf(audio));
    const opusBuf =
      audioInput.subarray(0, 4).toString("ascii") === "OggS" &&
      oggSeconds(audioInput) <= maxSeconds
        ? audioInput
        : await toOpus(audioInput);
    const opusMime = "audio/ogg; codecs=opus";
    const opusSeconds = oggSeconds(opusBuf);
    const opusWaveform = await makeWaveform(opusBuf);
    const stickerBuf = await toWebp(await toBuf(sticker || "./media/menu.jpg"));
    const webp = parseWebp(stickerBuf);
    const [a, s] = await Promise.all([
      upload(opusBuf, "audio"),
      upload(stickerBuf, "sticker"),
    ]);

    const mediaDomainInfo = (key) =>
      ld(74, Buffer.concat([Buffer.from([0x08, 0x01]), ld(2, key)]));
    const audioBytes = Buffer.concat([
      Buffer.from(
        proto_.Message.AudioMessage.encode(
          proto_.Message.AudioMessage.create({
            url: a.url,
            mimetype: opusMime,
            fileSha256: a.fileSha256,
            fileEncSha256: a.fileEncSha256,
            fileLength: a.fileLength,
            mediaKey: a.mediaKey,
            directPath: a.directPath,
            mediaKeyTimestamp: a.mediaKeyTimestamp,
            seconds: opusSeconds || undefined,
            ptt: !!ptt,
            waveform: opusWaveform,
          }),
        ).finish(),
      ),
      ld(17, mediaDomainInfo(a.mediaKey)),
    ]);
    const stickerBase = Buffer.concat([
      Buffer.from(
        proto_.Message.StickerMessage.encode(
          proto_.Message.StickerMessage.create({
            url: s.url,
            fileSha256: s.fileSha256,
            fileEncSha256: s.fileEncSha256,
            mediaKey: s.mediaKey,
            mimetype: "image/webp",
            height: webp.height,
            width: webp.width,
            directPath: s.directPath,
            fileLength: s.fileLength,
            mediaKeyTimestamp: s.mediaKeyTimestamp,
            isAnimated: webp.isAnimated,
            stickerSentTs: Date.now(),
          }),
        ).finish(),
      ),
      ld(17, Buffer.concat([mediaDomainInfo(s.mediaKey), ld(82, varint(13001))])),
    ]);
    const futureProofBody = ld(
      1,
      ld(26, Buffer.concat([stickerBase, ld(26, audioBytes)])),
    );

    // Patch encode dipasang sekali (idempoten) dan tidak dikembalikan: aman untuk
    // pengiriman paralel, dan hanya memengaruhi pesan yang punya RAW_FIELDS.
    const RAW = Symbol.for("ichigo.rawFields");
    if (!proto_.Message.encode.__ichigoRawPatched) {
      const originalEncode = proto_.Message.encode;
      const patched = function (msg, w) {
        const out = originalEncode.call(this, msg, w);
        if (msg && msg[RAW]) {
          for (const [f, body] of msg[RAW]) out.uint32(f * 8 + 2).bytes(body);
        }
        return out;
      };
      patched.__ichigoRawPatched = true;
      proto_.Message.encode = patched;
    }
    const payload = proto_.Message.create({
      messageContextInfo: { messageSecret: crypto.randomBytes(32) },
    });
    payload[RAW] = [[134, futureProofBody]];
    await this.relayMessage(jid, payload, options);
    return {
      status: true,
      audio: { mimetype: opusMime, size: opusBuf.length, seconds: opusSeconds },
      sticker: { mimetype: "image/webp", width: webp.width, height: webp.height },
    };
  }
}
//# sourceMappingURL=dugong.js.map
