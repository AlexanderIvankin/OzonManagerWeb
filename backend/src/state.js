const finishingOrders = new Map();      // orderId -> { startedAt, userId }
const pendingFinishConfirmations = new Map(); // orderId -> { originalChatId?, originalMessageId?, startedAt }
const pendingForms = new Map();         // key: userId_orderId -> { orderId, offers, allCompleted }
const processingOrders = new Set();     // orderId -> заказ сейчас обрабатывается

// Кэш фотографий товаров (in-memory): offer_id -> { sku, images: string[], updatedAt }
// Чтобы для каждого offer_id фото грузились с Ozon только один раз (до завершения заказа),
// а при завершении заказа кэш по его offer_id очищался.
const productImagesCache = new Map();

module.exports = {
  finishingOrders,
  pendingFinishConfirmations,
  pendingForms,
  processingOrders,
  productImagesCache,
};