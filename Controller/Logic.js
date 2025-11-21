const mongoose = require("mongoose");
const XLSX = require("xlsx");
const { Server } = require("socket.io");
const { Order, Notification } = require("../Models/Schema");
const User = require("../Models/Model");

const { sendMail } = require("../utils/mailer");
let io;

const initSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: process.env.APP_URL ,
      methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"],
    },
    path:"/furni/socket.io"
  });

   io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);
    // Explicit, scoped room joins
    socket.on("join", async (data) => {
      try {
        const userId = data?.userId;
        const role = data?.role;
        if (userId) {
          // Per-user room
          socket.join(`user:${userId}`);
          // If user belongs to a leader, also join leader room for team-wide updates
          try {
            const dbUser = await User.findById(userId).select("assignedToLeader role");
            if (dbUser?.assignedToLeader) {
              socket.join(`leader:${dbUser.assignedToLeader}`);
            }
          } catch (lookupErr) {
            console.warn("Failed to look up user for leader room join:", lookupErr?.message);
          }
        }
        if (role === "Admin") {
          socket.join("admins");
        }
        console.log(`Socket ${socket.id} joined scoped rooms for user:`, userId || "unknown");
      } catch (err) {
        console.warn("Join handler error for", socket.id, err?.message);
      }
    });
    socket.on("disconnect", () => {
      console.log("Client disconnected:", socket.id);
    });
  });
 
// Set up MongoDB change stream to watch for Order collection changes
  try {
    const changeStream = Order.watch([], { fullDocument: "updateLookup" });
    changeStream.on("change", async (change) => {
      console.log("Order collection change detected:", change.operationType);
      const fullDoc = change.fullDocument;
      const documentId = change.documentKey?._id;
      // Only emit to scoped rooms based on ownership
      if (fullDoc?.createdBy) {
        const targetRooms = new Set();
        targetRooms.add(`user:${String(fullDoc.createdBy)}`);
        if (fullDoc.assignedTo) {
          targetRooms.add(`user:${String(fullDoc.assignedTo)}`);
        }
        // Broadcast minimal payload
        const payload = {
          operationType: change.operationType,
          documentId,
          createdBy: String(fullDoc.createdBy),
          assignedTo: fullDoc.assignedTo ? String(fullDoc.assignedTo) : null,
          fullDocument: fullDoc,
        };
        for (const room of targetRooms) {
          io.to(room).emit("orderUpdate", payload);
        }
      }

      try {
        const dispatchFromOptions = [
          "Patna",
          "Bareilly",
          "Ranchi",
          "Lucknow",
          "Delhi",
          "Jaipur",
          "Rajasthan",
        ];
        const all = await Order.countDocuments({});
        const installation = await Order.countDocuments({
          dispatchStatus: "Delivered",
          installationStatus: { $in: ["Pending", "In Progress", "Site Not Ready", "Hold"] },
        });
        const dispatch = await Order.countDocuments({
          fulfillingStatus: "Fulfilled",
          dispatchStatus: { $ne: "Delivered" },
        });
        const production = await Order.countDocuments({
          sostatus: "Approved",
          dispatchFrom: { $nin: dispatchFromOptions },
          fulfillingStatus: { $ne: "Fulfilled" },
        });
        io.to("admins").emit("dashboardCounts", { all, installation, production, dispatch });
      } catch (countErr) {
        console.warn("Failed to emit admin dashboardCounts:", countErr?.message);
      }
    });

    // Handle change stream errors
    changeStream.on("error", (error) => {
      console.error("Change stream error:", error);
    });

    // Handle change stream close
    changeStream.on("close", () => {
      console.log("Change stream closed");
    });
  } catch (error) {
    console.error("Error setting up change stream:", error);
  }
}; 
// Shared function to create notifications
function createNotification(req, order, action) {
  const username = req.user?.username || "User";
  const customerName = order.customername || "Unknown";
  const orderId = order.orderId || "N/A";

  return new Notification({
    message: `${action} by ${username} for ${customerName} (Order ID: ${orderId})`,
    timestamp: new Date(),
    isRead: false,
    role: "All",
    userId: req.user?.id || null,
  });
}
// Get Dashbord Count 
const getDashboardCounts = async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    // Base visibility query
    let baseQuery = {};
    if (userRole === "Admin" || userRole === "SuperAdmin") {
      baseQuery = {};
    } else {
      const teamMembers = await User.find({ assignedToLeader: userId }).select("_id");
      const teamMemberIds = teamMembers.map((m) => m._id);
      const allUserIds = [userId, ...teamMemberIds];
      baseQuery = {
        $or: [
          { createdBy: { $in: allUserIds } },
          { assignedTo: { $in: allUserIds } },
        ],
      };
    }

    // Counts
    const all = await Order.countDocuments(baseQuery);

    const installation = await Order.countDocuments({
      ...baseQuery,
      dispatchStatus: "Delivered",
      installationStatus: { $in: ["Pending", "In Progress", "Site Not Ready", "Hold"] },
    });

    const dispatch = await Order.countDocuments({
      ...baseQuery,
      fulfillingStatus: "Fulfilled",
      dispatchStatus: { $ne: "Delivered" },
    });

    const dispatchFromOptions = [
      "Patna",
      "Bareilly",
      "Ranchi",
      "Lucknow",
      "Delhi",
      "Jaipur",
      "Rajasthan",
    ];
    const production = await Order.countDocuments({
      ...baseQuery,
      sostatus: "Approved",
      dispatchFrom: { $nin: dispatchFromOptions },
      fulfillingStatus: { $ne: "Fulfilled" },
    });

    return res.status(200).json({ all, installation, production, dispatch });
  } catch (error) {
    console.error("Error in getDashboardCounts:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch dashboard counts" });
  }
};


// Get all orders
const getAllOrders = async (req, res) => {
  try {
    const { role, id } = req.user;
    let orders;

    if (role === "Admin" || role === "SuperAdmin") {
      orders = await Order.find().populate("createdBy", "username email");
    } else if (role === "Sales") {
      orders = await Order.find({ createdBy: id }).populate(
        "createdBy",
        "username email"
      );
    } else {
      orders = await Order.find().populate("createdBy", "username email");
    }

    res.json(orders);
  } catch (error) {
    console.error("Error in getAllOrders:", error.message);
    res.status(500).json({ error: "Server error" });
  }
};

// Create a new order
const createOrder = async (req, res) => {
  try {
    const {
      name,
      city,
      state,
      pinCode,
      contactNo,
      alterno,
      customerEmail,
      customername,
      products,
      orderType,
      report,
      freightcs,
      installation,
      salesPerson,
      company,
      shippingAddress,
      billingAddress,
      sameAddress,
      total,
      gstno,
      freightstatus,
      installchargesstatus,
      paymentCollected,
      paymentMethod,
      paymentDue,
      neftTransactionId,
      chequeId,
      remarks,
      gemOrderNumber,
      deliveryDate,
      demoDate,
      paymentTerms,

      dispatchFrom,
      fulfillingStatus,
    } = req.body;

    // Validate required fields
    if (!customername || !name || !contactNo || !customerEmail) {
      return res.status(400).json({
        success: false,
        error: "Missing required customer details",
      });
    }
    if (!/^\d{10}$/.test(contactNo)) {
      return res.status(400).json({
        success: false,
        error: "Contact number must be exactly 10 digits",
      });
    }
    if (alterno && !/^\d{10}$/.test(alterno)) {
      return res.status(400).json({
        success: false,
        error: "Alternate contact number must be exactly 10 digits",
      });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
      return res.status(400).json({
        success: false,
        error: "Invalid email address",
      });
    }
    if (!state || !city || !pinCode) {
      return res.status(400).json({
        success: false,
        error: "Missing required address details",
      });
    }
    if (!/^\d{6}$/.test(pinCode)) {
      return res.status(400).json({
        success: false,
        error: "Pin Code must be exactly 6 digits",
      });
    }
    if (!shippingAddress || !billingAddress) {
      return res.status(400).json({
        success: false,
        error: "Missing billing or shipping address",
      });
    }
    if (orderType === "B2G" && !gemOrderNumber) {
      return res.status(400).json({
        success: false,
        error: "Missing GEM Order Number for B2G orders",
      });
    }
    if (orderType === "Demo" && !demoDate) {
      return res.status(400).json({
        success: false,
        error: "Missing Demo Date for Demo orders",
      });
    }
    if (!paymentTerms && orderType !== "Demo") {
      return res.status(400).json({
        success: false,
        error: "Payment Terms is required for non-Demo orders",
      });
    }

    // Validate dispatchFrom
    const validDispatchLocations = [
      "Patna",
      "Bareilly",
      "Ranchi",
      "Morinda",
      "Lucknow",
      "Delhi",
      "Jaipur",
      "Rajasthan",
    ];
    if (dispatchFrom && !validDispatchLocations.includes(dispatchFrom)) {
      return res.status(400).json({
        success: false,
        error: "Invalid dispatchFrom value",
      });
    }

    // Validate products
    for (const product of products) {
      if (
        !product.productType ||
        !product.qty ||
        !product.unitPrice ||
        !product.gst
      ) {
        return res.status(400).json({
          success: false,
          error: "Invalid product data",
          details:
            "Each product must have productType, qty, unitPrice, gst, and warranty",
        });
      }
      if (
        isNaN(Number(product.qty)) ||
        Number(product.qty) <= 0 ||
        isNaN(Number(product.unitPrice)) ||
        Number(product.unitPrice) < 0 ||
        (product.gst !== "including" &&
          (isNaN(Number(product.gst)) || Number(product.gst) < 0))
      ) {
        return res.status(400).json({
          success: false,
          error: "Invalid product data",
          details:
            "qty must be positive, unitPrice must be non-negative, and gst must be valid",
        });
      }
      // Set defaults
      product.size = product.size || "N/A";
      product.spec = product.spec || "N/A";

      product.modelNos = Array.isArray(product.modelNos)
        ? product.modelNos
        : [];
    }

    // Calculate total
    const calculatedTotal =
      products.reduce((sum, product) => {
        const qty = Number(product.qty) || 0;
        const unitPrice = Number(product.unitPrice) || 0;
        const gstRate =
          product.gst === "including" ? 0 : Number(product.gst) || 0;
        return sum + qty * unitPrice * (1 + gstRate / 100);
      }, 0) +
      Number(freightcs || 0) +
      Number(installation || 0);

    const calculatedPaymentDue =
      calculatedTotal - Number(paymentCollected || 0);

    // Create order
    const order = new Order({
      soDate: new Date(),
      name,
      city,
      state,
      pinCode,
      contactNo,
      alterno,
      customerEmail,
      customername,
      products,
      gstno,
      freightcs: freightcs || "",
      freightstatus: freightstatus || "Extra",
      installchargesstatus: installchargesstatus || "Extra",
      installation: installation || "N/A",
      report,
      salesPerson,
      company,
      orderType: orderType || "B2C",
      shippingAddress,
      billingAddress,
      sameAddress,
      total:
        total !== undefined && !isNaN(total) ? Number(total) : calculatedTotal,
      paymentCollected: String(paymentCollected || ""),
      paymentMethod: paymentMethod || "",
      paymentDue:
        paymentDue !== undefined && !isNaN(paymentDue)
          ? String(paymentDue)
          : String(calculatedPaymentDue),
      neftTransactionId: neftTransactionId || "",
      chequeId: chequeId || "",
      remarks,
      gemOrderNumber: gemOrderNumber || "",
      deliveryDate: deliveryDate ? new Date(deliveryDate) : null,
      paymentTerms: paymentTerms || "",
      demoDate: demoDate ? new Date(demoDate) : null,

      createdBy: req.user.id,
      dispatchFrom,
      fulfillingStatus:
        fulfillingStatus ||
        (dispatchFrom === "Morinda" ? "Pending" : "Fulfilled"),
    });

    // Save order
    const savedOrder = await order.save();
   
   const notification = new Notification({
      message: `New sales order created by ${req.user.username || "User"} for ${
        savedOrder.customername || "Unknown"
      } (Order ID: ${savedOrder.orderId || "N/A"})`,
      timestamp: new Date(),
      isRead: false,
      role: "All",
      userId: req.user.id,
    });
    await notification.save();
   
    try {
      const notifRooms = new Set();
   
      if (savedOrder?.createdBy) notifRooms.add(`user:${String(savedOrder.createdBy)}`);
    
      if (savedOrder?.assignedTo) notifRooms.add(`user:${String(savedOrder.assignedTo)}`);
     
      notifRooms.add("admins");

      const notifPayload = {
        _id: String(notification._id),
        message: notification.message,
        timestamp: notification.timestamp,
        isRead: notification.isRead,
        userId: notification.userId ? String(notification.userId) : null,
        orderId: savedOrder.orderId || String(savedOrder._id),
      };
     
      io.to([...notifRooms]).emit("notification", notifPayload); 
    } catch (emitErr) {
      console.warn("Failed to emit scoped notification:", emitErr?.message);
    }
    res.status(201).json({ success: true, data: savedOrder });
  } catch (error) {
    console.error("Error in createOrder:", error);
    if (error.name === "ValidationError") {
      const messages = Object.values(error.errors).map((err) => err.message);
      return res.status(400).json({
        success: false,
        error: "Validation failed",
        details: messages,
      });
    }
    res.status(500).json({
      success: false,
      error: "Server error",
      details: error.message,
    });
  }
};
// Edit an existing order

const editEntry = async (req, res) => {
  try {
    const orderId = req.params.id;
    const updateData = req.body;

    // Log request body for debugging
    console.log("Edit request body:", updateData);

    // Fetch existing order
    const existingOrder = await Order.findById(orderId);
    if (!existingOrder) {
      return res.status(404).json({
        success: false,
        error: "Order not found",
      });
    }

    // Define allowed fields for update
    const allowedFields = [
      "soDate",
      "dispatchFrom",
      "dispatchDate",
      "name",
      "city",
      "state",
      "pinCode",
      "contactNo",
      "alterno",
      "customerEmail",
      "customername",
      "products",
      "total",
      "gstno",
      "freightstatus",
      "installchargesstatus",
      "paymentCollected",
      "paymentMethod",
      "paymentDue",
      "neftTransactionId",
      "chequeId",
      "freightcs",
      "orderType",
      "installation",
      "installationStatus",
      "remarksByInstallation",
      "dispatchStatus",
      "salesPerson",
      "report",
      "company",
      "installationReport",
      "transporterDetails",
      
      "receiptDate",
      "shippingAddress",
      "billingAddress",
      "sameAddress",
      "invoiceNo",
      "invoiceDate",
      "fulfillingStatus",
      "remarksByProduction",
      "remarksByAccounts",
      "paymentReceived",
      "billNumber",
      "piNumber",
      "remarksByBilling",
      "verificationRemarks",
      "billStatus",
      "completionStatus",
      "fulfillmentDate",
      "remarks",
      "sostatus",
      "gemOrderNumber",
      "deliveryDate",
      "stamp",
      "demoDate",
      "paymentTerms",
      "actualFreight",

      "remarksBydispatch",
    ];

    // Create update object with only provided fields
    const updateFields = {};
    for (const field of allowedFields) {
      if (updateData[field] !== undefined) {
        if (
          field.endsWith("Date") &&
          updateData[field] &&
          !isNaN(new Date(updateData[field]))
        ) {
          updateFields[field] = new Date(updateData[field]);
        } else {
          updateFields[field] = updateData[field];
        }
      }
    }

    // Automatically set completionStatus to
    if (updateData.fulfillingStatus === "Fulfilled") {
      updateFields.completionStatus = "Complete";
      if (!updateFields.fulfillmentDate) {
        updateFields.fulfillmentDate = new Date();
      }
    }
    // Automatically set completionStatus when order is cancelled
if (updateData.fulfillingStatus === "Order Cancel") {
  updateFields.sostatus = "Order Cancelled";

}
if (updateData.fulfillingStatus === "Hold") {
  updateFields.sostatus = "Hold By Production";
}
    // Update the order
    const updatedOrder = await Order.findByIdAndUpdate(
      orderId,
      { $set: updateFields },
      { new: true, runValidators: false }
    );

    if (!updatedOrder) {
      return res.status(404).json({
        success: false,
        error: "Order not found",
      });
    } 

    if (
      updateFields.sostatus === "Approved" &&
      updatedOrder.customerEmail &&
      existingOrder.sostatus !== "Approved"
    ) {
      try {
        const subject = `Your Order is Approved!`;
        const text = `
Dear ${updatedOrder.customername || "Customer"},

We're thrilled to confirm that your order for the following products has been approved! Get ready for an amazing experience with Promark Tech Solutions:

${updatedOrder.products
  .map(
    (p, i) =>
      `${i + 1}. ${p.productType} - Qty: ${p.qty}, Unit Price: ₹${
        p.unitPrice
      }, Brand: ${p.brand}`
  )
  .join("\n")}

Total: ₹${updatedOrder.total || 0}

Let's make it happen! Reach out to us to explore the next steps.

Cheers,
The Promark Tech Solutions Crew
        `;
        const html = `
           <!DOCTYPE html>
          <html>
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
              @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap');
              body { font-family: 'Poppins', Arial, sans-serif; background-color: #f0f2f5; margin: 0; padding: 0; line-height: 1.6; }
              .container { max-width: 720px; margin: 40px auto; background-color: #ffffff; border-radius: 24px; overflow: hidden; box-shadow: 0 10px 20px rgba(0,0,0,0.15); }
              .hero { background: linear-gradient(135deg, #1e3a8a, #3b82f6); padding: 60px 20px; text-align: center; position: relative; }
              .hero::before { content: ''; position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: url('https://www.transparenttextures.com/patterns/subtle-white-feathers.png'); opacity: 0.1; }
              .hero h1 { color: #ffffff; font-size: 38px; font-weight: 700; margin: 0; text-shadow: 0 3px 6px rgba(0,0,0,0.3); letter-spacing: 1.2px; }
              .hero p { color: #ffffff; font-size: 20px; opacity: 0.95; margin: 15px 0; font-weight: 400; }
              .content { padding: 50px 30px; background-color: #ffffff; }
              .content h2 { color: #1f2937; font-size: 28px; font-weight: 600; margin-bottom: 20px; }
              .content p { color: #4b5563; font-size: 16px; line-height: 1.9; margin: 0 0 25px; }
              .highlight { background: linear-gradient(135deg, #e0f2fe, #bfdbfe); padding: 25px; border-radius: 16px; text-align: center; font-size: 18px; font-weight: 500; color: #1f2937; box-shadow: 0 4px 8px rgba(0,0,0,0.1); }
              .products {  padding: 30px;}
              .products ul { list-style: none; padding: 0; margin: 0; }
              .products li { font-size: 16px; color: #1f2937; margin-bottom: 16px; display: flex; align-items: center; transition: transform 0.3s ease; }
              .products li:hover { transform: translateX(12px); }
              .products li::before { content: '✨'; color: #f59e0b; margin-right: 12px; font-size: 20px; }
              .cta-button { 
                display: inline-block; 
                padding: 20px 40px; 
                background: linear-gradient(135deg, #22c55e, #16a34a); 
                color: #000000; /* Changed text color to black for Contact Us Now button */
                text-decoration: none; 
                border-radius: 50px; 
                font-size: 18px; 
                font-weight: 600; 
                margin: 30px 0; 
                box-shadow: 0 6px 12px rgba(0,0,0,0.2); 
                transition: all 0.3s ease; 
                position: relative; 
                overflow: hidden; 
              }
              .cta-button::after { 
                content: ''; 
                position: absolute; 
                top: 0; 
                left: -100%; 
                width: 100%; 
                height: 100%; 
                background: linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent); 
                transition: 0.5s; 
              }
              .cta-button:hover::after { left: 100%; }
              .cta-button:hover { 
                transform: translateY(-4px); 
                box-shadow: 0 8px 16px rgba(0,0,0,0.3); 
                background: linear-gradient(135deg, #16a34a, #22c55e); 
              }
              .footer { text-align: center; padding: 40px; background:linear-gradient(135deg, #1e3a8a, #3b82f6); color: #6b7280; font-size: 14px; }
              .footer a { color: #1e3a8a; text-decoration: none; font-weight: 600; }
              .footer a:hover { text-decoration: underline; }
              .social-icons { margin-top: 20px; }
              .social-icons a { margin: 0 15px; display: inline-block; transition: transform 0.3s ease; }
              .social-icons a:hover { transform: scale(1.3); }
              .social-icons img { width: 30px; height: 30px; }
              @media (max-width: 600px) {
                .container { margin: 20px; }
                .hero h1 { font-size: 30px; }
                .hero p { font-size: 16px; }
                .content { padding: 30px; }
                .content h2 { font-size: 24px; }
                .cta-button { padding: 16px 32px; font-size: 16px; }
                .products { padding: 20px; }
                .highlight { padding: 20px; }
              }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="hero">
                <h1>Order Approved!</h1>
                <p>Kickstarting Your Journey with Promark Tech Solutions!</p>
              </div>
              <div class="content">
                <h2>Dear ${updatedOrder.customername || "Customer"},</h2>
                <p>We're over the moon to announce that your order has been officially approved! You're about to experience the magic of your selected products with Promark Tech Solutions.</p>
               <div class="products" style="margin-top:10px;">
  <ul style="list-style-type:none; padding:0; margin:0;">
    ${updatedOrder.products
      .map(
        (p, i) =>
          `<li style="margin-bottom:8px; padding:6px 10px;">
            <strong style="color:#333;">${p.productType}</strong> 
            <span style="margin-left:10px; color:#555;">Qty: ${p.qty}</span>, 
           
          </li>`
      )
      .join("")}
  </ul>
</div>

                
                <p>Ready to dive into the next steps? Our team is here to make your experience seamless and extraordinary. Let's make it happen!</p>
                <a href="mailto:support@promarktechsolutions.com" class="cta-button">Contact Us Now</a>
              </div>
              <div class="footer" style="color: #e0f2fe;">
                <p>With enthusiasm,<br/>The Promark Tech Solutions Crew</p>
                <p>&copy; 2025 <a href="https://promarktechsolutions.com">Promark Tech Solutions</a>. All rights reserved.</p>
                <div class="social-icons">
                  <a href="https://twitter.com/promarktech"><img src="https://img.icons8.com/color/30/000000/twitter.png" alt="Twitter"></a>
                  <a href="https://linkedin.com/company/promarktechsolutions"><img src="https://img.icons8.com/color/30/000000/linkedin.png" alt="LinkedIn"></a>
                  <a href="https://instagram.com/promarktechsolutions"><img src="https://img.icons8.com/color/30/000000/instagram.png" alt="Instagram"></a>
                </div>
              </div>
            </div>
          </body>
          </html>
        `;
        await sendMail(updatedOrder.customerEmail, subject, text, html);
      } catch (mailErr) {
        console.error(
          "Order confirmation email sending failed:",
          mailErr.message
        );
      }
    }
    // Send email if dispatchStatus is updated to "Dispatched" or "Delivered"

    if (
      (updateFields.dispatchStatus === "Dispatched" ||
        updateFields.dispatchStatus === "Delivered") &&
      updatedOrder.customerEmail
    ) {
     try {
        const statusText =
          updateFields.dispatchStatus === "Dispatched"
            ? "dispatched"
            : "delivered";
        const subject = `Your Order Has Been ${
          statusText.charAt(0).toUpperCase() + statusText.slice(1)
        }!`;
        const text = `
Dear ${updatedOrder.customername || "Customer"},

Great news! Your order has been ${statusText}. Here are the details of your order:

${updatedOrder.products
  .map(
    (p, i) =>
      `${i + 1}. ${p.productType} - Qty: ${p.qty}, Brand: ${p.brand}, Size: ${p.size}, Spec: ${p.spec}`
  )
  .join("\n")}
We're here to support you every step of the way!

Cheers,
The Promark Tech Solutions Crew
        `;
        const html = `
        <!DOCTYPE html>
          <html>
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
              @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap');
              body { font-family: 'Poppins', Arial, sans-serif; background-color: #f0f2f5; margin: 0; padding: 0; line-height: 1.6; }
              .container { max-width: 720px; margin: 40px auto; background-color: #ffffff; border-radius: 24px; overflow: hidden; box-shadow: 0 10px 20px rgba(0,0,0,0.15); }
              .hero { background: linear-gradient(135deg, #16a34a, #4ade80, #22c55e);
; padding: 60px 20px; text-align: center; position: relative; }
              .hero::before { content: ''; position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: url('https://www.transparenttextures.com/patterns/subtle-white-feathers.png'); opacity: 0.1; }
              .hero h1 { color: #ffffff; font-size: 38px; font-weight: 700; margin: 0; text-shadow: 0 3px 6px rgba(0,0,0,0.3); letter-spacing: 1.2px; }
              .hero p { color: #ffffff; font-size: 20px; opacity: 0.95; margin: 15px 0; font-weight: 400; }
              .content { padding: 50px 30px; background-color: #ffffff; }
              .content h2 { color: #1f2937; font-size: 28px; font-weight: 600; margin-bottom: 20px; }
              .content p { color: #4b5563; font-size: 16px; line-height: 1.9; margin: 0 0 25px; }
              .highlight {  padding: 25px;  text-align: center; font-size: 18px; font-weight: 500; color: #1f2937;  }
              .products {  padding: 30px;  }
              .products ul { list-style: none; padding: 0; margin: 0; }
              .products li { font-size: 16px; color: #1f2937; margin-bottom: 16px; display: flex; align-items: center; transition: transform 0.3s ease; }
              .products li:hover { transform: translateX(12px); }
              .products li::before { content: '✨'; color: #f59e0b; margin-right: 12px; font-size: 20px; }
              .cta-button { 
                display: inline-block; 
                padding: 20px 40px; 
                background: linear-gradient(135deg, #22c55e, #16a34a); 
                color: #000000; /* Changed text color to black for Get in Touch button */
                text-decoration: none; 
                border-radius: 50px; 
                font-size: 18px; 
                font-weight: 600; 
                margin: 30px 0; 
                box-shadow: 0 6px 12px rgba(0,0,0,0.2); 
                transition: all 0.3s ease; 
                position: relative; 
                overflow: hidden; 
              }
              .cta-button::after { 
                content: ''; 
                position: absolute; 
                top: 0; 
                left: -100%; 
                width: 100%; 
                height: 100%; 
                background: linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent); 
                transition: 0.5s; 
              }
              .cta-button:hover::after { left: 100%; }
              .cta-button:hover { 
                transform: translateY(-4px); 
                box-shadow: 0 8px 16px rgba(0,0,0,0.3); 
                background: linear-gradient(135deg, #16a34a, #22c55e); 
              }
              .footer { text-align: center; padding: 40px; background: linear-gradient(135deg, #16a34a, #4ade80, #22c55e); color: #6b7280; font-size: 14px; }
              .footer a { color: #0858cf; text-decoration: none; font-weight: 600; }
              .footer a:hover { text-decoration: underline; }
              .social-icons { margin-top: 20px; }
              .social-icons a { margin: 0 15px; display: inline-block; transition: transform 0.3s ease; }
              .social-icons a:hover { transform: scale(1.3); }
              .social-icons img { width: 30px; height: 30px; }
              @media (max-width: 600px) {
                .container { margin: 20px; }
                .hero h1 { font-size: 30px; }
                .hero p { font-size: 16px; }
                .content { padding: 30px; }
                .content h2 { font-size: 24px; }
                .cta-button { padding: 16px 32px; font-size: 16px; }
                .products { padding: 20px; }
                .highlight { padding: 20px; }
              }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="hero">
                <h1>Order ${
          statusText.charAt(0).toUpperCase() + statusText.slice(1)
        }!</h1>
                <p>Your Next Step with Promark Tech Solutions!</p>
              </div>
              <div class="content">
                <h2>Dear ${updatedOrder.customername || "Customer"},</h2>
                <p>Fantastic news! Your order has been ${statusText}, bringing you one step closer to enjoying the excellence of Promark Tech Solutions. Here's what's in your order:</p>
                <div class="products" style="margin-top:10px;">
  <ul style="list-style-type:none; padding:0; margin:0;">
    ${updatedOrder.products
      .map(
        (p, i) =>
          `<li style="margin-bottom:10px; padding:8px 12px;">
            <strong style="color:#333;">${p.productType}</strong> 
            <span style="margin-left:12px; color:#555;">Qty: ${p.qty}</span>
          </li>`
      )
      .join("")}
  </ul>
</div>
                <p>We're here to ensure your experience is nothing short of spectacular! Reach out with any questions or to explore what's next.</p>
                <a href="mailto:support@promarktechsolutions.com" class="cta-button">Get in Touch</a>
              </div>
              <div class="footer" style="color: white;">
                <p>With enthusiasm,<br/>The Promark Tech Solutions Crew</p>
                <p>&copy; 2025 <a href="https://promarktechsolutions.com">Promark Tech Solutions</a>. All rights reserved.</p>
                <div class="social-icons">
                  <a href="https://twitter.com/promarktech"><img src="https://img.icons8.com/color/30/000000/twitter.png" alt="Twitter"></a>
                  <a href="https://linkedin.com/company/promarktechsolutions"><img src="https://img.icons8.com/color/30/000000/linkedin.png" alt="LinkedIn"></a>
                  <a href="https://instagram.com/promarktechsolutions"><img src="https://img.icons8.com/color/30/000000/instagram.png" alt="Instagram"></a>
                </div>
              </div>
            </div>
          </body>
          </html>
        `;
        await sendMail(updatedOrder.customerEmail, subject, text, html);
      } catch (mailErr) {
        console.error(
          `${updateFields.dispatchStatus} email sending failed:`,
          mailErr.message
        );
      }
    }

    // Create and save notification
   const notification = new Notification({
  message: `Order updated by ${
    req.user?.username || 
    req.user?.name || 
    req.user?.email || 
    req.user?.id || 
    "Unknown User"
  } for ${updatedOrder.customername || "Unknown"} (Order ID: ${
    updatedOrder.orderId || "N/A"
  })`,
  timestamp: new Date(),
  isRead: false,
  role: "All",
  userId: req.user?.id || null,
});
await notification.save();
    try {
      const notifRooms = new Set();
      if (updatedOrder?.createdBy)
        notifRooms.add(`user:${String(updatedOrder.createdBy)}`);
      if (updatedOrder?.assignedTo)
        notifRooms.add(`user:${String(updatedOrder.assignedTo)}`);
      notifRooms.add("admins");

      const notifPayload = {
        _id: String(notification._id),
        message: notification.message,
        timestamp: notification.timestamp,
        isRead: notification.isRead,
        userId: notification.userId ? String(notification.userId) : null,
        orderId: updatedOrder.orderId || String(updatedOrder._id),
      };
      
      io.to([...notifRooms]).emit("notification", notifPayload);
    } catch (emitErr) {
      console.warn("Failed to emit scoped notification (editEntry):", emitErr?.message);
    }

    res.status(200).json({ success: true, data: updatedOrder });
  } catch (error) {
    console.error("Error in editEntry:", error);
    res.status(500).json({
      success: false,
      error: "Server error",
      details: error.message,
    });
  }
};
// Delete an order
const DeleteData = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid order ID" });
    }

    const order = await Order.findById(req.params.id);
    if (!order) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }

    if (
      req.user.role === "Sales" &&
      order.createdBy.toString() !== req.user.id
    ) {
      return res
        .status(403)
        .json({ success: false, message: "Unauthorized to delete this order" });
    }

    await Order.findByIdAndDelete(req.params.id);
    // Create and save notification
    const notification = createNotification(req, order, "Order deleted");
    await notification.save();

    // Emit only to the order owner and admins
       const targetRooms = new Set();
    targetRooms.add(`user:${String(order.createdBy)}`);
    if (order.assignedTo) targetRooms.add(`user:${String(order.assignedTo)}`);
    const payload = {
      _id: order._id,
      customername: order.customername,
      orderId: order.orderId,
      createdBy: String(order.createdBy),
      assignedTo: order.assignedTo ? String(order.assignedTo) : null,
    };
    
    io.to([...targetRooms]).emit("deleteOrder", payload);


    try {
      const notifRooms = new Set(targetRooms);
      notifRooms.add("admins");
      const notifPayload = {
        _id: String(notification._id),
        message: notification.message,
        timestamp: notification.timestamp,
        isRead: notification.isRead,
        userId: notification.userId ? String(notification.userId) : null,
        orderId: order.orderId || String(order._id),
      };
      io.to([...notifRooms]).emit("notification", notifPayload);
    } catch (emitErr) {
      console.warn("Failed to emit scoped notification (deleteOrder):", emitErr?.message);
    }

    res
      .status(200)
      .json({ success: true, message: "Order deleted successfully" });
  } catch (error) {
    console.error("Error deleting order:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete order",
      error: error.message,
    });
  }
};

// Parse date strings
const parseDate = (dateStr) => {
  if (!dateStr) return null;
  const date = new Date(String(dateStr).trim());
  return isNaN(date.getTime()) ? null : date;
};

// Bulk upload orders
const bulkUploadOrders = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "No file uploaded",
      });
    }

    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const jsonData = XLSX.utils.sheet_to_json(sheet);

    const orders = [];
    const validDispatchLocations = [
      "Patna",
      "Bareilly",
      "Ranchi",
      "Morinda",
      "Lucknow",
      "Delhi",
      "Jaipur",
      "Rajasthan",
    ];

    for (const row of jsonData) {
      const products = [
        {
          productType: row["Product Type"] || "",
          size: row["Size"] || "N/A",
          spec: row["Specification"] || "N/A",
          qty: Number(row["Quantity"]) || 0,
          unitPrice: Number(row["Unit Price"]) || 0,
          gst: row["GST"] || "18",
          modelNos: row["Model Nos"]
            ? String(row["Model Nos"])
                .split(",")
                .map((m) => m.trim())
            : [],
          brand: row["Brand"] || "",
          warranty:
            row["Warranty"] ||
            (row["Order Type"] === "B2G"
              ? "As Per Tender"
              : row["Product Type"] === "IFPD" && row["Brand"] === "Promark"
              ? "3 Years"
              : "1 Year"),
        },
      ];

      // Validate products
      for (const product of products) {
        if (
          !product.productType ||
          !product.qty ||
          !product.unitPrice ||
          !product.gst ||
          !product.warranty
        ) {
          return res.status(400).json({
            success: false,
            error: `Invalid product data in row: ${JSON.stringify(row)}`,
          });
        }
        if (
          isNaN(Number(product.qty)) ||
          Number(product.qty) <= 0 ||
          isNaN(Number(product.unitPrice)) ||
          (product.gst !== "including" && isNaN(Number(product.gst)))
        ) {
          return res.status(400).json({
            success: false,
            error: `Invalid product data in row: ${JSON.stringify(row)}`,
          });
        }
        if (
          product.productType === "IFPD" &&
          (!product.modelNos || !product.brand)
        ) {
          return res.status(400).json({
            success: false,
            error: `Model Numbers and Brand are required for IFPD products in row: ${JSON.stringify(
              row
            )}`,
          });
        }
      }

      // Calculate total
      const calculatedTotal =
        products.reduce((sum, product) => {
          const qty = Number(product.qty) || 0;
          const unitPrice = Number(product.unitPrice) || 0;
          const gstRate =
            product.gst === "including" ? 0 : Number(product.gst) || 0;
          return sum + qty * unitPrice * (1 + gstRate / 100);
        }, 0) +
        Number(row["Freight Charges"] || 0) +
        Number(row["Installation Charges"] || 0);

      const calculatedPaymentDue =
        calculatedTotal - Number(row["Payment Collected"] || 0);

      // Validate dispatchFrom
      if (
        row["Dispatch From"] &&
        !validDispatchLocations.includes(row["Dispatch From"])
      ) {
        return res.status(400).json({
          success: false,
          error: `Invalid dispatchFrom value in row: ${JSON.stringify(row)}`,
        });
      }

      // Create order object
      const order = {
        soDate: row["SO Date"] ? new Date(row["SO Date"]) : new Date(),
        dispatchFrom: row["Dispatch From"] || "",
        name: row["Contact Person Name"] || "",
        city: row["City"] || "",
        state: row["State"] || "",
        pinCode: row["Pin Code"] || "",
        contactNo: row["Contact No"] || "",
        alterno: row["Alternate No"] || "",
        customerEmail: row["Customer Email"] || "",
        customername: row["Customer Name"] || "",
        products,
        total: calculatedTotal,
        gstno: row["GST No"] || "",
        freightcs: row["Freight Charges"] || "",
        freightstatus: row["Freight Status"] || "Extra",
        installchargesstatus: row["Installation Charges Status"] || "Extra",
        installation: row["Installation Charges"] || "N/A",
        report: row["Reporting Manager"] || "",
        salesPerson: row["Sales Person"] || "",
        company: row["Company"] || "Promark",
        orderType: row["Order Type"] || "B2C",
        shippingAddress: row["Shipping Address"] || "",
        billingAddress: row["Billing Address"] || "",
        sameAddress: row["Same Address"] === "Yes" || false,
        paymentCollected: String(row["Payment Collected"] || ""),
        paymentMethod: row["Payment Method"] || "",
        paymentDue: String(calculatedPaymentDue),
        neftTransactionId: row["NEFT Transaction ID"] || "",
        chequeId: row["Cheque ID"] || "",
        remarks: row["Remarks"] || "",
        gemOrderNumber: row["GEM Order Number"] || "",
        deliveryDate: row["Delivery Date"]
          ? new Date(row["Delivery Date"])
          : null,
        paymentTerms: row["Payment Terms"] || "",

        createdBy: req.user.id,
      };

      orders.push(order);
    }

    // Save orders
    const savedOrders = await Order.insertMany(orders);

    // Emit to respective creators and admins only
    savedOrders.forEach((o) => {
      const creator = o.createdBy?.toString?.() || req.user.id.toString();
      io.to(creator).emit("newOrder", { order: o });
      io.to("admins").emit("newOrder", { order: o });
    });

    res.status(201).json({
      success: true,
      message: "Orders uploaded successfully",
      data: savedOrders,
    });
  } catch (error) {
    console.error("Error in bulkUploadOrders:", error);
    if (error.name === "ValidationError") {
      const messages = Object.values(error.errors).map((err) => err.message);
      return res.status(400).json({
        success: false,
        error: "Validation failed",
        details: messages,
      });
    }
    res.status(500).json({
      success: false,
      error: "Server error",
      details: error.message,
    });
  }
};

// Export orders to Excel
const exportentry = async (req, res) => {
  try {
    const { role, id } = req.user;
    let orders;

    if (role === "Admin" || role === "SuperAdmin") {
      orders = await Order.find().lean();
    } else if (role === "Sales") {
      orders = await Order.find({ createdBy: id }).lean();
    } else {
      orders = await Order.find().lean();
    }

    if (!Array.isArray(orders) || orders.length === 0) {
      const ws = XLSX.utils.json_to_sheet([]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Orders");

      const fileBuffer = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=orders_${new Date()
          .toISOString()
          .slice(0, 10)}.xlsx`
      );
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      return res.send(fileBuffer);
    }

    // Format entries for Excel
    const formattedEntries = orders.flatMap((entry) => {
      const products =
        Array.isArray(entry.products) && entry.products.length > 0
          ? entry.products
          : [
              {
                productType: "Not Found",
                size: "N/A",
                spec: "N/A",
                qty: 0,
                unitPrice: 0,
                serialNos: [],
                modelNos: [],
                gst: 0,
                brand: "",
              },
            ];

      return products.map((product, index) => {
        const entryData = {
          orderId: entry.orderId || "",
          soDate: entry.soDate
            ? new Date(entry.soDate).toISOString().slice(0, 10)
            : "",
          dispatchFrom: entry.dispatchFrom || "",
          dispatchDate: entry.dispatchDate
            ? new Date(entry.dispatchDate).toISOString().slice(0, 10)
            : "",
          name: entry.name || "",
          city: entry.city || "",
          state: entry.state || "",
          pinCode: entry.pinCode || "",
          contactNo: entry.contactNo || "",
          alterno: entry.alterno || "",
          customerEmail: entry.customerEmail || "",
          customername: entry.customername || "",
        };

        const productData = {
          productType: product.productType || "",
          size: product.size || "N/A",
          spec: product.spec || "N/A",
          qty: product.qty || 0,
          unitPrice: product.unitPrice || 0,

          modelNos: Array.isArray(product.modelNos)
            ? product.modelNos.join(", ")
            : "",
          gst: product.gst || 0,
        };

        const conditionalData =
          index === 0
            ? {
                total: entry.total || 0,
                paymentCollected: entry.paymentCollected || "",
                paymentMethod: entry.paymentMethod || "",
                paymentDue: entry.paymentDue || "",
                neftTransactionId: entry.neftTransactionId || "",
                chequeId: entry.chequeId || "",
                freightcs: entry.freightcs || "",
                freightstatus: entry.freightstatus || "",
                installchargesstatus: entry.installchargesstatus || "",
                gstno: entry.gstno || "",
                orderType: entry.orderType || "Private",
                installation: entry.installation || "N/A",
                installationStatus: entry.installationStatus || "Pending",
                remarksByInstallation: entry.remarksByInstallation || "",
                dispatchStatus: entry.dispatchStatus || "Not Dispatched",
                salesPerson: entry.salesPerson || "",
                report: entry.report || "",
                company: entry.company || "Promark",

                transporterDetails: entry.transporterDetails || "",
               
                shippingAddress: entry.shippingAddress || "",
                billingAddress: entry.billingAddress || "",
                invoiceNo: entry.invoiceNo || "",
                fulfillingStatus: entry.fulfillingStatus || "Pending",
                remarksByProduction: entry.remarksByProduction || "",
                remarksByAccounts: entry.remarksByAccounts || "",
                paymentReceived: entry.paymentReceived || "Not Received",
                billNumber: entry.billNumber || "",
                piNumber: entry.piNumber || "",
                remarksByBilling: entry.remarksByBilling || "",
                verificationRemarks: entry.verificationRemarks || "",
                billStatus: entry.billStatus || "Pending",
                completionStatus: entry.completionStatus || "In Progress",
                remarks: entry.remarks || "",
                sostatus: entry.sostatus || "Pending for Approval",
              }
            : {
                total: "",
                paymentCollected: "",
                paymentMethod: "",
                paymentDue: "",
                neftTransactionId: "",
                chequeId: "",
                freightcs: "",
                freightstatus: "",
                installchargesstatus: "",
                gstno: "",
                orderType: "",
                installation: "",
                installationStatus: "",
                remarksByInstallation: "",
                dispatchStatus: "",
                salesPerson: "",
                report: "",
                company: "",

                transporterDetails: "",
               
                shippingAddress: "",
                billingAddress: "",
                invoiceNo: "",
                fulfillingStatus: "",
                remarksByProduction: "",
                remarksByAccounts: "",
                paymentReceived: "",
                billNumber: "",
                piNumber: "",
                remarksByBilling: "",
                verificationRemarks: "",
                billStatus: "",
                completionStatus: "",
                remarks: "",
                sostatus: "",
              };

        const dateData = {
          receiptDate: entry.receiptDate
            ? new Date(entry.receiptDate).toISOString().slice(0, 10)
            : "",
          invoiceDate: entry.invoiceDate
            ? new Date(entry.invoiceDate).toISOString().slice(0, 10)
            : "",
          fulfillmentDate: entry.fulfillmentDate
            ? new Date(entry.fulfillmentDate).toISOString().slice(0, 10)
            : "",
        };

        return {
          ...entryData,
          ...productData,
          ...conditionalData,
          ...dateData,
        };
      });
    });

    const ws = XLSX.utils.json_to_sheet(formattedEntries);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Orders");

    const fileBuffer = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=orders_${new Date()
        .toISOString()
        .slice(0, 10)}.xlsx`
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.send(fileBuffer);
  } catch (error) {
    console.error("Error in exportentry:", error);
    res.status(500).json({
      success: false,
      message: "Failed to export orders",
      error: error.message,
    });
  }
};

// Fetch finished goods orders
const getFinishedGoodsOrders = async (req, res) => {
  try {
    const orders = await Order.find({
      fulfillingStatus: "Fulfilled",
      stamp: { $ne: "Received" },
    }).populate("createdBy", "username email");
    res.status(200).json({ success: true, data: orders });
  } catch (error) {
    console.error("Error in getFinishedGoodsOrders:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch finished goods orders",
      error: error.message,
    });
  }
};
// Fetch verification orders
const getVerificationOrders = async (req, res) => {
  try {
    const orders = await Order.find({
      paymentTerms: { $in: ["100% Advance", "Partial Advance"] },
      sostatus: { $nin: ["Accounts Approved", "Approved"] },
    }).populate("createdBy", "username email");
    res.json({ success: true, data: orders });
  } catch (error) {
    console.error("Error in getVerificationOrders:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch verification orders",
      error: error.message,
    });
  }
};
// Fetch bill orders
const getBillOrders = async (req, res) => {
  try {
    const orders = await Order.find({
      sostatus: "Approved",
      billStatus: { $ne: "Billing Complete" },
    }).populate("createdBy", "username email");
    res.json({ success: true, data: orders });
  } catch (error) {
    console.error("Error in getBillOrders:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch bill orders",
      error: error.message,
    });
  }
};
// Fetch installation orders

const getInstallationOrders = async (req, res) => {
  try {
    const orders = await Order.find({
      dispatchStatus: "Delivered",
      // stamp: "Received",
      installationReport: { $ne: "Yes" },
      installationStatus: {
        $in: [
          "Pending",
          "In Progress",
          "Failed",
          "Completed",
          "Hold by Salesperson",
          "Hold by Customer",
          "Site Not Ready",
        ],
      },
    }).populate("createdBy", "username email");
    res.json({ success: true, data: orders });
  } catch (error) {
    console.error("Error in getInstallationOrders:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch installation orders",
      error: error.message,
    });
  }
};

// Fetch accounts orders
const getAccountsOrders = async (req, res) => {
  try {
    const orders = await Order.find({
      installationStatus: "Completed",
      paymentReceived: { $ne: "Received" },
    }).populate("createdBy", "username email");

    res.json({ success: true, data: orders });
  } catch (error) {
    console.error("Error in getAccountsOrders:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch accounts orders",
      error: error.message,
    });
  }
};

// Fetch production approval orders
const getProductionApprovalOrders = async (req, res) => {
  try {
    const orders = await Order.find({
      $or: [
        { sostatus: "Accounts Approved" },
        {
          $and: [
            { sostatus: "Pending for Approval" },
            { paymentTerms: "Credit" },
          ],
        },
      ],
    }).populate("createdBy", "username email");
    res.json({ success: true, data: orders });
  } catch (error) {
    console.error("Error in getProductionApprovalOrders:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch production approval orders",
      error: error.message,
    });
  }
};

// Fetch production orders
const getProductionOrders = async (req, res) => {
  try {
    const dispatchFromOptions = [
      "Patna",
      "Bareilly",
      "Ranchi",
      "Lucknow",
      "Delhi",
      "Jaipur",
      "Rajasthan",
    ];

    const orders = await Order.find({
     sostatus: { $in: ["Approved", "Hold By Production"] },
      dispatchFrom: { $nin: dispatchFromOptions },
      fulfillingStatus: { $nin:["Fulfilled", "Order Cancel"]},
    }).lean();

    res.status(200).json({ success: true, data: orders });
  } catch (error) {
    console.error("Error in getProductionOrders:", error.message);
    res.status(500).json({
      success: false,
      message: "Error fetching production orders",
      error: error.message,
    });
  }
}; // Fetch notifications
const getNotifications = async (req, res) => {
  try {
    if (!req.user || !req.user.id) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized: User not authenticated",
      });
    }
    console.log("Fetching notifications for user:", req.user.id);
    const notifications = await Notification.find({
      $or: [
        { role: "All" },
        { userId: req.user.id },
      ],
    })
      .sort({ timestamp: -1 })
      .limit(50);
    console.log("Notifications found:", notifications.length);
    res.status(200).json({ success: true, data: notifications });
  } catch (error) {
    console.error("Error in getNotifications:", {
      message: error.message,
      stack: error.stack,
      name: error.name,
    });
    res.status(500).json({
      success: false,
      message: "Failed to fetch notifications",
      error: error.message,
    });
  }
};

// Mark notifications as read
const markNotificationsRead = async (req, res) => {
  try {
    const filter = req.user?.id
      ? { $or: [{ role: "All" }, { userId: req.user.id }] }
      : { role: "All" };
    await Notification.updateMany(filter, { isRead: true });
    res
      .status(200)
      .json({ success: true, message: "Notifications marked as read" });
  } catch (error) {
    console.error("Error in markNotificationsRead:", error.stack);
    res.status(500).json({
      success: false,
      message: "Failed to mark notifications as read",
      error: error.message,
    });
  }
};

// Clear notifications
const clearNotifications = async (req, res) => {
  try {
    const filter = req.user?.id
      ? { $or: [{ role: "All" }, { userId: req.user.id }] }
      : { role: "All" };
    await Notification.deleteMany(filter);
    res.status(200).json({ success: true, message: "Notifications cleared" });
  } catch (error) {
    console.error("Error in clearNotifications:", error.stack);
    res.status(500).json({
      success: false,
      message: "Failed to clear notifications",
      error: error.message,
    });
  }
};
module.exports = {
  initSocket,
  getAllOrders,
  createOrder,
  editEntry,
  DeleteData,
  bulkUploadOrders,
  exportentry,
  getFinishedGoodsOrders,
  getVerificationOrders,
  getProductionApprovalOrders,
  getBillOrders,
  getInstallationOrders,
  getAccountsOrders,
  getProductionOrders,
  getNotifications,
  markNotificationsRead,
  clearNotifications,
  getDashboardCounts 
};
