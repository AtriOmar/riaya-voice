import axios from "axios";
import { config } from "dotenv";

config();

/** Axios client for the Next.js app REST API (`NEXTJS_API_URL`). */
export const nextjsApi = axios.create({
	baseURL: process.env.NEXTJS_API_URL,
	headers: {
		"Content-Type": "application/json",
	},
});
