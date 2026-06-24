export function getFileType(mimetype) {
  const map = {
    "application/pdf": "pdf",
    "text/plain": "txt",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      "docx",
  };

  return map[mimetype] || "unknown";
}