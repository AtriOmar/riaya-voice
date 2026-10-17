import axios from "axios";
import { config } from "dotenv";

config();

/**
 * Axios client for the Next.js app REST API (`NEXTJS_API_URL`). Every call is
 * server-to-server, so it always carries the shared `x-internal-secret`.
 */
export const nextjsApi = axios.create({
	baseURL: process.env.NEXTJS_API_URL,
	headers: {
		"Content-Type": "application/json",
		"x-internal-secret": process.env.INTERNAL_API_SECRET ?? "",
	},
});
