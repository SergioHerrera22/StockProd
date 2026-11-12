"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApiError = void 0;
class ApiError extends Error {
    status;
    details;
    constructor(status, message, details) {
        super(message);
        this.status = status;
        this.details = details;
    }
    static badRequest(message, details) {
        return new ApiError(400, message, details);
    }
    static unauthorized(message = 'No autorizado') {
        return new ApiError(401, message);
    }
    static forbidden(message = 'No tenes permiso para esta operacion') {
        return new ApiError(403, message);
    }
    static notFound(message = 'Recurso no encontrado') {
        return new ApiError(404, message);
    }
    static conflict(message, details) {
        return new ApiError(409, message, details);
    }
}
exports.ApiError = ApiError;
