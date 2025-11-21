const express = require("express");
const router = express.Router();
const Controller = require("../Controller/Logic");

const { verifyToken } = require("../utils/config jwt");

router.get("/get-orders", verifyToken, Controller.getAllOrders);
router.get(
  "/installation-orders",
  verifyToken,
  Controller.getInstallationOrders
);
router.get("/accounts-orders", verifyToken, Controller.getAccountsOrders);
router.post("/orders", verifyToken, Controller.createOrder);
router.delete("/delete/:id", verifyToken, Controller.DeleteData);
router.put("/edit/:id",verifyToken, Controller.editEntry);
router.get("/export", verifyToken, Controller.exportentry);
router.post("/bulk-orders", verifyToken, Controller.bulkUploadOrders);
router.get(
  "/production-orders",
  verifyToken,

  Controller.getProductionOrders
);
router.get("/dashboard-counts", verifyToken, Controller.getDashboardCounts);
router.get("/finished-goods", verifyToken, Controller.getFinishedGoodsOrders);
router.get(
  "/get-verification-orders",
  verifyToken,
  Controller.getVerificationOrders
);
router.get(
  "/production-approval-orders",
  verifyToken,

  Controller.getProductionApprovalOrders
);
router.get("/get-bill-orders", verifyToken, Controller.getBillOrders);
router.get("/notifications", verifyToken, Controller.getNotifications);
router.post("/mark-read", verifyToken, Controller.markNotificationsRead);
router.delete("/clear", verifyToken, Controller.clearNotifications);
module.exports = router;
