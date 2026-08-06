import { writeDebugArtifact } from "./debug";
import type { NativeCompactionRuntime } from "./runtime";
import type { NativeCompactionRequestBody } from "./serializer";
import type { ArtifactContext, ExtensionSettings } from "./types";

const SSE_CONTENT_TYPE = "text/event-stream";
const JSON_CONTENT_TYPE = "application/json";
const REMOTE_COMPACTION_V2_FEATURE = "remote_compaction_v2";

type ResponsesCompletedEnvelope = {
	id: string;
	created_at?: number | string;
	status?: string;
	[key: string]: unknown;
};

type NativeCompactionV2RequestBody = Omit<NativeCompactionRequestBody, "input"> & {
	input: unknown[];
	store: false;
	stream: true;
};

export type NativeCompactionClientFailureReason =
	| "aborted"
	| "network-error"
	| "non-2xx"
	| "empty-body"
	| "invalid-json"
	| "malformed-response"
	| "empty-output"
	| "response-error";

export type NativeCompactionClientSuccess = {
	ok: true;
	status: number;
	compactedWindow: unknown[];
	compactResponseId: string;
	createdAt?: string;
	response: ResponsesCompletedEnvelope;
};

export type NativeCompactionClientFailure = {
	ok: false;
	reason: NativeCompactionClientFailureReason;
	status?: number;
	errorMessage?: string;
	responseText?: string;
	responseJson?: unknown;
};

export type NativeCompactionClientResult = NativeCompactionClientSuccess | NativeCompactionClientFailure;

export type ExecuteNativeCompactionOptions = {
	runtime: NativeCompactionRuntime;
	request: NativeCompactionRequestBody;
	signal?: AbortSignal;
	settings?: ExtensionSettings;
	context?: ArtifactContext;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
	return (
		(error instanceof DOMException && error.name === "AbortError") ||
		(error instanceof Error && (error.name === "AbortError" || error.name === "ABORT_ERR"))
	);
}

function normalizeResponseTimestamp(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		const milliseconds = value > 1_000_000_000_000 ? value : value * 1000;
		return new Date(milliseconds).toISOString();
	}

	if (typeof value !== "string") {
		return undefined;
	}

	const trimmed = value.trim();
	if (!trimmed) {
		return undefined;
	}

	const parsed = Date.parse(trimmed);
	return Number.isNaN(parsed) ? trimmed : new Date(parsed).toISOString();
}

function validCompactionMetadata(value: unknown): boolean {
	return value === undefined || value === null || (
		isRecord(value) &&
		(value.turn_id === undefined || value.turn_id === null || typeof value.turn_id === "string")
	);
}

function canonicalCompactionOutput(value: unknown): Record<string, unknown> | undefined {
	if (!isRecord(value) || (value.type !== "compaction_summary" && value.type !== "compaction")) {
		return undefined;
	}
	if (typeof value.encrypted_content !== "string" || value.encrypted_content.trim().length === 0) {
		return undefined;
	}
	if (value.id !== undefined && value.id !== null && typeof value.id !== "string") {
		return undefined;
	}
	if (!validCompactionMetadata(value.internal_chat_message_metadata_passthrough)) {
		return undefined;
	}

	const metadata = value.internal_chat_message_metadata_passthrough;
	return {
		type: "compaction",
		...(typeof value.id === "string" ? { id: value.id } : {}),
		encrypted_content: value.encrypted_content,
		...(isRecord(metadata)
			? {
				internal_chat_message_metadata_passthrough:
					typeof metadata.turn_id === "string" ? { turn_id: metadata.turn_id } : {},
			}
			: {}),
	};
}

function buildV2RequestBody(request: NativeCompactionRequestBody): NativeCompactionV2RequestBody {
	return {
		...structuredClone(request),
		input: [
			...request.input.map((item) => structuredClone(item)),
			{ type: "compaction_trigger" },
		],
		store: false,
		stream: true,
	};
}

function findSseBoundary(buffer: string): { index: number; length: number } | undefined {
	const matches = ["\r\n\r\n", "\n\n", "\r\r"]
		.map((separator) => ({ index: buffer.indexOf(separator), length: separator.length }))
		.filter((match) => match.index >= 0)
		.sort((left, right) => left.index - right.index);
	return matches[0];
}

function parseSseData(block: string): string | undefined {
	const data: string[] = [];
	for (const line of block.replace(/\r\n|\r/g, "\n").split("\n")) {
		if (line.startsWith(":")) {
			continue;
		}
		const colon = line.indexOf(":");
		const field = colon < 0 ? line : line.slice(0, colon);
		let value = colon < 0 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) {
			value = value.slice(1);
		}
		if (field === "data") {
			data.push(value);
		}
	}
	return data.length > 0 ? data.join("\n") : undefined;
}

async function* readSseData(response: Response, signal?: AbortSignal): AsyncGenerator<string> {
	if (!response.body) {
		return;
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			if (signal?.aborted) {
				throw new DOMException("Request was aborted", "AbortError");
			}
			const { done, value } = await reader.read();
			buffer += decoder.decode(value, { stream: !done });
			while (true) {
				const boundary = findSseBoundary(buffer);
				if (!boundary) {
					break;
				}
				const block = buffer.slice(0, boundary.index);
				buffer = buffer.slice(boundary.index + boundary.length);
				const data = parseSseData(block);
				if (data !== undefined) {
					yield data;
				}
			}
			if (done) {
				break;
			}
		}
		const trailing = parseSseData(buffer);
		if (trailing !== undefined) {
			yield trailing;
		}
	} finally {
		reader.releaseLock();
	}
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) {
		return undefined;
	}

	try {
		const payloadText = Buffer.from(parts[1]!, "base64url").toString("utf8");
		const payload = JSON.parse(payloadText);
		return isRecord(payload) ? payload : undefined;
	} catch {
		return undefined;
	}
}

function extractCodexAccountId(token: string): string | undefined {
	const payload = decodeJwtPayload(token);
	const authClaims = payload?.["https://api.openai.com/auth"];
	if (!isRecord(authClaims)) {
		return undefined;
	}

	const accountId = authClaims.chatgpt_account_id;
	return typeof accountId === "string" && accountId.trim().length > 0 ? accountId.trim() : undefined;
}

function buildCodexUserAgent(): string {
	const platform = typeof process !== "undefined" ? process.platform : "browser";
	const arch = typeof process !== "undefined" ? process.arch : "unknown";
	return `pi (${platform}; ${arch})`;
}

function toHeaders(runtime: NativeCompactionRuntime): Record<string, string> {
	const headers = new Headers(runtime.currentModel.headers ?? {});
	for (const [key, value] of Object.entries(runtime.headers ?? {})) {
		headers.set(key, value);
	}
	headers.set("accept", SSE_CONTENT_TYPE);
	headers.set("content-type", JSON_CONTENT_TYPE);
	if (!headers.has("authorization")) {
		headers.set("authorization", `Bearer ${runtime.apiKey}`);
	}

	const features = (headers.get("x-codex-beta-features") ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	if (!features.includes(REMOTE_COMPACTION_V2_FEATURE)) {
		features.push(REMOTE_COMPACTION_V2_FEATURE);
	}
	headers.set("x-codex-beta-features", features.join(","));

	if (runtime.provider === "openai-codex") {
		const accountId = extractCodexAccountId(runtime.apiKey);
		if (accountId) {
			headers.set("chatgpt-account-id", accountId);
		}
		headers.set("originator", "pi");
		headers.set("user-agent", buildCodexUserAgent());
		headers.set("openai-beta", "responses=experimental");
	}

	return Object.fromEntries(headers.entries());
}

function writeCompactArtifact(
	data: unknown,
	settings: ExtensionSettings | undefined,
	context: ArtifactContext | undefined,
): void {
	if (!settings || !context) {
		return;
	}

	writeDebugArtifact("compact-response", data, settings, context);
}

function responseErrorMessage(event: Record<string, unknown>): string {
	if (event.type === "error") {
		return typeof event.message === "string" ? event.message : "Responses compaction v2 returned an error event";
	}
	const response = isRecord(event.response) ? event.response : undefined;
	const error = response && isRecord(response.error) ? response.error : undefined;
	if (error && typeof error.message === "string") {
		return error.message;
	}
	const details = response && isRecord(response.incomplete_details) ? response.incomplete_details : undefined;
	if (details && typeof details.reason === "string") {
		return details.reason;
	}
	return event.type === "response.incomplete"
		? "Responses compaction v2 returned an incomplete response"
		: "Responses compaction v2 returned a failed response";
}

export async function executeNativeCompaction(
	options: ExecuteNativeCompactionOptions,
): Promise<NativeCompactionClientResult> {
	const { runtime, request, signal, settings, context } = options;
	const headers = toHeaders(runtime);
	const body = buildV2RequestBody(request);
	const artifactRequest = {
		url: runtime.responsesUrl,
		headers,
		body,
	};
	const fail = (
		failure: NativeCompactionClientFailure,
		response?: { status: number; headers: Record<string, string>; body?: unknown },
	): NativeCompactionClientFailure => {
		writeCompactArtifact(
			{
				request: artifactRequest,
				...(response ? { response } : {}),
				outcome: failure,
			},
			settings,
			context,
		);
		return failure;
	};

	if (signal?.aborted) {
		return fail({ ok: false, reason: "aborted" });
	}

	try {
		const response = await fetch(runtime.responsesUrl, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal,
		});
		const responseHeaders: Record<string, string> = {};
		response.headers.forEach((value, key) => {
			responseHeaders[key] = value;
		});

		if (!response.ok) {
			const responseText = await response.text();
			let responseJson: unknown;
			if (responseText.trim().length > 0) {
				try {
					responseJson = JSON.parse(responseText);
				} catch {
					responseJson = undefined;
				}
			}
			return fail(
				{
					ok: false,
					reason: "non-2xx",
					status: response.status,
					responseText: responseText || undefined,
					responseJson,
				},
				{
					status: response.status,
					headers: responseHeaders,
					body: responseJson ?? responseText,
				},
			);
		}

		if (!response.body) {
			return fail(
				{ ok: false, reason: "empty-body", status: response.status },
				{ status: response.status, headers: responseHeaders },
			);
		}

		const events: unknown[] = [];
		const compactions: Record<string, unknown>[] = [];
		let completed: ResponsesCompletedEnvelope | undefined;
		for await (const data of readSseData(response, signal)) {
			if (data === "[DONE]") {
				continue;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(data);
			} catch (error) {
				return fail(
					{
						ok: false,
						reason: "invalid-json",
						status: response.status,
						errorMessage: error instanceof Error ? error.message : String(error),
						responseText: data,
					},
					{ status: response.status, headers: responseHeaders, body: events },
				);
			}
			events.push(parsed);
			if (!isRecord(parsed) || typeof parsed.type !== "string") {
				return fail(
					{ ok: false, reason: "malformed-response", status: response.status, responseJson: parsed },
					{ status: response.status, headers: responseHeaders, body: events },
				);
			}

			if (parsed.type === "response.output_item.done") {
				const item = parsed.item;
				if (isRecord(item) && (item.type === "compaction_summary" || item.type === "compaction")) {
					const compaction = canonicalCompactionOutput(item);
					if (!compaction) {
						return fail(
							{ ok: false, reason: "malformed-response", status: response.status, responseJson: item },
							{ status: response.status, headers: responseHeaders, body: events },
						);
					}
					compactions.push(compaction);
				}
				continue;
			}

			if (parsed.type === "response.completed") {
				if (!isRecord(parsed.response) || typeof parsed.response.id !== "string" || parsed.response.id.trim().length === 0) {
					return fail(
						{ ok: false, reason: "malformed-response", status: response.status, responseJson: parsed },
						{ status: response.status, headers: responseHeaders, body: events },
					);
				}
				completed = parsed.response as ResponsesCompletedEnvelope;
				continue;
			}

			if (parsed.type === "response.failed" || parsed.type === "response.incomplete" || parsed.type === "error") {
				return fail(
					{
						ok: false,
						reason: "response-error",
						status: response.status,
						errorMessage: responseErrorMessage(parsed),
						responseJson: parsed,
					},
					{ status: response.status, headers: responseHeaders, body: events },
				);
			}
		}

		if (!completed) {
			return fail(
				{
					ok: false,
					reason: "malformed-response",
					status: response.status,
					errorMessage: "Responses compaction v2 stream ended before response.completed",
				},
				{ status: response.status, headers: responseHeaders, body: events },
			);
		}
		if (compactions.length === 0) {
			return fail(
				{ ok: false, reason: "empty-output", status: response.status, responseJson: completed },
				{ status: response.status, headers: responseHeaders, body: events },
			);
		}
		if (compactions.length !== 1) {
			return fail(
				{
					ok: false,
					reason: "malformed-response",
					status: response.status,
					errorMessage: `Responses compaction v2 expected exactly one compaction output item, got ${compactions.length}`,
					responseJson: compactions,
				},
				{ status: response.status, headers: responseHeaders, body: events },
			);
		}

		const success: NativeCompactionClientSuccess = {
			ok: true,
			status: response.status,
			compactedWindow: [compactions[0]!],
			compactResponseId: completed.id.trim(),
			createdAt: normalizeResponseTimestamp(completed.created_at),
			response: completed,
		};
		writeCompactArtifact(
			{
				request: artifactRequest,
				response: {
					status: response.status,
					headers: responseHeaders,
					body: events,
				},
				outcome: {
					ok: true,
					status: success.status,
					compactResponseId: success.compactResponseId,
					createdAt: success.createdAt,
					compactedItems: success.compactedWindow.length,
				},
			},
			settings,
			context,
		);
		return success;
	} catch (error) {
		return fail(
			isAbortError(error)
				? { ok: false, reason: "aborted" }
				: {
					ok: false,
					reason: "network-error",
					errorMessage: error instanceof Error ? error.message : String(error),
				},
		);
	}
}
