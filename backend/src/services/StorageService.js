const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { s3, BUCKET, PREFIX, MODELS_PREFIX } = require('../config/s3');
const {
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');

const CACHE_DIR = path.join(__dirname, '../../models-cache');
// TTL локального кэша zip (по умолчанию 1 час) — настраивается в .env
const CACHE_TTL = (parseInt(process.env.MODELS_CACHE_TTL_MIN, 10) || 60) * 60 * 1000;

class StorageService {
  static ensureCacheDir() {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  }

  static keyFor(offerId) {
    // s3://bucket/[PREFIX]models/{offer_id}.zip
    return `${PREFIX}${MODELS_PREFIX}${offerId}.zip`;
  }

  static cachePath(offerId) {
    return path.join(CACHE_DIR, `${offerId}.zip`);
  }

  /**
   * Имя файла, отдаваемое клиенту: ARD000003-N.zip
   */
  static fileNameFor(offerId) {
    return `${offerId}.zip`;
  }

  // Залить zip в S3
  static async uploadZip(offerId, buffer, contentType = 'application/zip') {
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: this.keyFor(offerId),
      Body: buffer,
      ContentType: contentType,
    }));
    // сбросить локальный кэш (файл обновлён — старый кэш недействителен)
    const cp = this.cachePath(offerId);
    if (fs.existsSync(cp)) fs.unlinkSync(cp);
  }

  // Скачать zip: сначала кэш, потом S3, с прогревом кэша.
  // Возвращает путь к файлу в локальном кэше.
  static async fetchZipToCache(offerId) {
    this.ensureCacheDir();
    const cp = this.cachePath(offerId);

    if (fs.existsSync(cp)) {
      const st = fs.statSync(cp);
      if (st.mtimeMs + CACHE_TTL > Date.now()) return cp;
      fs.unlinkSync(cp); // просрочен
    }

    const resp = await s3.send(new GetObjectCommand({
      Bucket: BUCKET,
      Key: this.keyFor(offerId),
    }));

    await pipeline(resp.Body, fs.createWriteStream(cp));
    return cp;
  }

  /**
   * Гарантирует наличие zip в кэше и возвращает { path, size }.
   * Используется перед отдачей файла клиенту (Content-Length + streaming).
   */
  static async getZipInfo(offerId) {
    const cp = await this.fetchZipToCache(offerId);
    const st = fs.statSync(cp);
    return { path: cp, size: st.size };
  }

  static async exists(offerId) {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: this.keyFor(offerId) }));
      return true;
    } catch { return false; }
  }

  static async deleteZip(offerId) {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: this.keyFor(offerId) }));
    const cp = this.cachePath(offerId);
    if (fs.existsSync(cp)) fs.unlinkSync(cp);
  }
  // Очистка просроченного кэша (для scheduler)
  static cleanCache() {
    if (!fs.existsSync(CACHE_DIR)) return 0;
    let removed = 0;
    for (const f of fs.readdirSync(CACHE_DIR)) {
      const fp = path.join(CACHE_DIR, f);
      const st = fs.statSync(fp);
      if (st.mtimeMs + CACHE_TTL <= Date.now()) {
        fs.unlinkSync(fp);
        removed++;
      }
    }
    return removed;
  }
}

module.exports = StorageService;