const finishingOrders = new Map();      // orderId -> { startedAt, userId }
const pendingFinishConfirmations = new Map(); // orderId -> { originalChatId?, originalMessageId?, startedAt }
const pendingForms = new Map();         // key: userId_orderId -> { orderId, offers, allCompleted }
const processingOrders = new Set();     // orderId -> заказ сейчас обрабатывается

module.exports = {
  finishingOrders,
  pendingFinishConfirmations,
  pendingForms,
  processingOrders,
};