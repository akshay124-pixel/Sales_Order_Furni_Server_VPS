// middleware/checkProductionRole.js

const checkProductionRole = (req, res, next) => {
  try {
    // Extract role from request headers
    const role = req.headers["role"];

    // Check if the role is not provided or is not "Production"
    if (!role || role !== "Production") {
      return res.status(403).json({
        success: false,
        message: "Access denied. Production role required.",
      });
    }

    next(); // Allow request to proceed if the role is correct
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error in role verification.",
      error: error.message,
    });
  }
};

module.exports = checkProductionRole;
