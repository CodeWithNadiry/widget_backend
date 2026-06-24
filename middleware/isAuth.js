import jwt from "jsonwebtoken";

export function isAuth(req, res, next) {

  const authHeader = req.get("Authorization");

  if (!authHeader) {
    return res.status(401).json({ message: "Not authenticated." });
  }

  const token = authHeader.split(" ")[1];


  if (!token) {
    return res.status(401).json({ message: "Token missing." });
  }

  try {
    const decodedToken = jwt.verify(token, process.env.JWT_SECRET);

    req.userId = decodedToken.userId;
    req.userEmail = decodedToken.email;

    next();
  } catch (error) {
    return res.status(401).json({ message: "invalid or expired token." });
  }
}