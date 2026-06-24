export class AppError extends Error {
  constructor(message, statusCode) {
    super(message); // calls of the Error Class =====>>> this.message = "Invalid credentials";
    this.statusCode = statusCode;
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found") {
    super(message, 404);
  }
}

export class BadRequestError extends AppError {
  constructor(message = "Bad request") {
    super(message, 400);
  }
}

export class ValidationError extends AppError {
  constructor(message = "Validation failed") {
    super(message, 422);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(message, 401);
  }
}
// super ====>> calls the parent's constructor function
// constructor ==========>>> is a special method that runs automatically when you create an object with new. Its job is to initialize the object.

// So the purpose of a constructor is:
// To set up an object with the data it needs when it is created. In your error classes, constructors initialize the message and statusCode for each error instance.
