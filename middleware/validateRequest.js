import { AppError } from "../utils/AppError.js";

export const validateRequest = (schemas) => {
  return (req, res, next) => {
    try {
      if (!schemas) throw new AppError("No schema provided", 500);

      // if single schema → treat as body
      const schemaMap = schemas.safeParse ? { body: schemas } : schemas;

      const { body, params, query } = schemaMap;

      if (body) {
        const result = body.safeParse(req.body);
        if (!result.success) {
          const message = Object.values(result.error.flatten().fieldErrors)
            .flat()
            .join(", ");
          throw new AppError(message || "Validation failed", 422);
        }
        req.body = result.data;
      }

      if (params) {
        const result = params.safeParse(req.params);
        if (!result.success) {
          const message = Object.values(result.error.flatten().fieldErrors)
            .flat()
            .join(", ");
          throw new AppError(message || "Validation failed", 422);
        }
        req.params = result.data;
      }

      if (query) {
        const result = query.safeParse(req.query);
        if (!result.success) {
          const message = Object.values(result.error.flatten().fieldErrors)
            .flat()
            .join(", ");
          throw new AppError(message || "Validation failed", 422);
        }
        req.query = result.data;
      }

      next();
    } catch (err) {
      next(err);
    }
  };
};