export function errorHandler(err, req, res, next) {
  console.log('err', err)
  const status = err.statusCode || 500;
  const message = err.message || "Internal Server Error";
  const data = err.data || null;

  res.status(status).json({ message, data });
}