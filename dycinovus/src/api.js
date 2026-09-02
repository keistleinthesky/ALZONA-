import axios from "axios";

const API_URL = "http://localhost:8000";

export const sendAudio = async (blob) => {

  const formData = new FormData();

  formData.append(
    "audio",
    blob,
    "voice.webm"
  );

  const response = await axios.post(
    `${API_URL}/chat`,
    formData
  );

  return response.data;
};
