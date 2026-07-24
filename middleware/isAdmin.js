// Must be used after isAuth — relies on req.userRole being set there.
export function isAdmin(req, res, next) {
  if (req.userRole !== "admin") {
    return res.status(403).json({ message: "Admin access required." });
  }
  next();
}