import { documentService } from "./document.service.js";

export async function uploadDocuments(req, res, next) {
  try {
    const result = await documentService.uploadDocuments(req);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getDocumentsByChatbot(req, res, next) {
  try {
    const { chatbotId } = req.params;
    const result = await documentService.getDocumentsByChatbot(chatbotId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function deleteDocument(req, res, next) {
  try {
    const { documentId } = req.params;
    const result = await documentService.deleteDocument(documentId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}