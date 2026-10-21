import { createServer, type Socket } from "node:net";
import type { TestContext } from "node:test";
import { createSecureContext, TLSSocket } from "node:tls";

// This self-signed key pair is exclusively for an isolated loopback test server.
const key = `-----BEGIN PRIVATE KEY-----
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQDeyIBAlzxWGWi9
i3GcZEqnOvwvH4lvTNtAgQhq7vsccW/rkvT/lSkDaXmsrthNeXaTaiS20P4UbAKR
tEBy+5K6Yjr7/Nx1mHOfG9D7Gfr95VfMtHnuXECLzZzWCib882VWwpNGpm5/N7je
lVdcVmcKKMhTNrnMCiymTjIPB3uA75R96FUxDzBp/35syRYS2/0Jm/TbTK/ayvQl
YTy7zVlpkw1VqYJK7fDvGYXa+LWbo8xKRlrS/b6uImDmPQ/J17tmR6P2UI5h+Nwz
EOIBR/gNHGNghm0SMLTdZQ0nPB8mjDoXuKB8db0P7Pa/V69RcuogHCqEJ1djfX1k
cKM8O3GhAgMBAAECggEAA0mf6+QXc7lRBIAM64cG24ApNcxQN8RhdWqaDFLtwXoS
kd5Dr4xc1DQvo5rabg1BcNQ3ibucjkJYSNxpOZEpFYdK0cpl2fXnmeTcEQKNg8bp
RGfy5y+1E6MTggyZDfFNEOpS6E9fMNEqkR1Q0lfjkiCvMRwtAnvxc/xSLIramZjY
colQnaK3262UXGHj0HiuTJwl9bQIEAKipvuSs+N93Ezr08Bi3987BmXo/oXGuqiG
eWy/fZEx8ur5YOjKCk1NAS8qctV4aGgiV5c+aLoG6Khwj751u5poNNNwpskd3dZ1
MThsQatCB/pAG7DLBHWyHz8BomS8ovAzWkP0nRjj2QKBgQDw3cjwR7vn8c/29Vip
BHRnUC9N6lr5TlNuJahB5vsCKl841LhAAnNgFeddgehPnSphPkgRVmRXvlBkJiAF
Y5BBoedAF9Y9xdnx8xgzM89FXsN8i7WKk9fhnHRAKKfvjTE0fY4KDwbFgLU4qn0r
tOIQ4Co5Dd0rlUZ+Zwg/H8lRqQKBgQDsx9uXFefIWRmD+CZ9LHMYC9OrP7ID1KUk
OfasKKXODctFprSK6JiBIXoNf5saEy+hY+G4vlyVIWf2OtuSw10zB4hbqdLTq37W
NJEE1q/RxIXovCB3iYbVo/d1FjLeHa/Z2JsGowgkumOPpFCufhoKuzqrLVUMjrJF
LZFzrnYLOQKBgQDiyVAKvN/10b5n3jYuXZ1kMSF5ETG7Dr6LNTWpZ1vrfA3QKqmY
yzXqwHTpnAkp/OcMTGH6wQcVfoGe6i64JDiNM23S8R6tZv6ASsz8WMnNnR4exESY
R/+501+5kQ4eBSjRLW5xlhhgGYGH6y6T2moITagztBQMly6akVQ4aytYkQKBgQCD
BeDcTPHSaoN1BFcAAx25G6pIY9m0xvGPB0gZYfDGAdoOs73J9AWXxxeL6qXAGwfL
TcL1ANmoaDDoDw+7ucGT4EIzPtj76jUogTQSMl5ePFpBPADXRNHI3I+tSdhiEplh
ebvnQ0XZVQ6MyMcgl4T/lTVUzaP3a+r33sxS8CI/+QKBgQDhiwBhs8PdXby+BHuk
9Bv4sfZd+EdiwLU1o+I+zSFGcq5AXv59yhXyuLPfBdgsbqsh+lXaMhhh6NjhNp+F
8RUMOjZx/D3WoRdKySKoXYDAz4DVuNk1CJimtI1iJ0d9oSoTAAVJx4kcUYYZjqYt
mIyrsu/DSZqwugVi/KuSI58Vlg==
-----END PRIVATE KEY-----
`;
const cert = `-----BEGIN CERTIFICATE-----
MIIC6DCCAdCgAwIBAgIUV7IiEMMo0Xx47MEFLEgSqZQE30EwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MTAxMTE1MjY1NFoXDTI2MTAx
MjE1MjY1NFowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEA3siAQJc8VhlovYtxnGRKpzr8Lx+Jb0zbQIEIau77HHFv
65L0/5UpA2l5rK7YTXl2k2okttD+FGwCkbRAcvuSumI6+/zcdZhznxvQ+xn6/eVX
zLR57lxAi82c1gom/PNlVsKTRqZufze43pVXXFZnCijIUza5zAospk4yDwd7gO+U
fehVMQ8waf9+bMkWEtv9CZv020yv2sr0JWE8u81ZaZMNVamCSu3w7xmF2vi1m6PM
SkZa0v2+riJg5j0Pyde7Zkej9lCOYfjcMxDiAUf4DRxjYIZtEjC03WUNJzwfJow6
F7igfHW9D+z2v1evUXLqIBwqhCdXY319ZHCjPDtxoQIDAQABozIwMDAdBgNVHQ4E
FgQUMdD4nNFHf6frOJr2cdqEm71IMoUwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG
9w0BAQsFAAOCAQEAJ8RIdeDu07nDO1DLbkxLv4G64GrrqNTU/LIKN1d7oLRmK9Z8
mxX80SWT/8jKHhmyNlBD0KbA/1C1J6LtccqtNi9WLhr0L20V8aOQfjw56HLjo294
H4cma+lJlmjV63Su9q5Bc8LKn80j+CK6UFv2tpx7OZV63P5RObny/LQADimCMI3H
ZiuZFVaWZ53ort8f1NO5/ZUikdmx4gUY9sfqWbK20BlLZEWP8VwFq7PkaaXkg6Wf
tr8uHywzhgVb05kqDKTnyv4Uwi28VDFgyWnJsVhQrN+cHpxsv6pgxbY3h5WyPZss
4gQrhXCDrUH3ZM0OySiy3Q6ro5fsVBK229Tm2A==
-----END CERTIFICATE-----
`;

export type SmtpScenario =
	| "accepted"
	| "partial"
	| "reject_envelope"
	| "reject_data"
	| "drop_after_data";

function greetingReply(encrypted: boolean) {
	return encrypted
		? "250-localhost\r\n250 AUTH PLAIN LOGIN\r\n"
		: "250-localhost\r\n250 STARTTLS\r\n";
}

function recipientReply(scenario: SmtpScenario, line: string) {
	const rejected =
		scenario === "reject_envelope" ||
		(scenario === "partial" && line.includes("hidden@example.com"));
	return rejected ? "550 No such recipient\r\n" : "250 Recipient accepted\r\n";
}

function dataReply(scenario: SmtpScenario) {
	return scenario === "reject_data"
		? "550 Message rejected\r\n"
		: "250 Queued\r\n";
}

export async function createSmtpTestServer(
	t: TestContext,
	scenario: SmtpScenario,
) {
	const context = createSecureContext({ key, cert });
	const sockets = new Set<Socket>();
	const messages: string[] = [];
	const mailFrom: string[] = [];

	const server = createServer((connection) => {
		let socket: Socket = connection;
		let encrypted = false;
		let buffer = "";
		let data: string[] | null = null;
		sockets.add(connection);

		function receiveData(line: string, lines: string[]) {
			if (line !== ".") {
				lines.push(line);
				return;
			}
			messages.push(lines.join("\r\n"));
			data = null;
			if (scenario === "drop_after_data") socket.destroy();
			else socket.write(dataReply(scenario));
		}

		function upgradeToTls() {
			socket.off("data", receive);
			socket.write("220 Upgrade TLS\r\n");
			socket = new TLSSocket(connection, {
				isServer: true,
				secureContext: context,
			});
			sockets.add(socket);
			encrypted = true;
			attach();
		}

		function command(line: string) {
			if (data !== null) return receiveData(line, data);

			if (/^EHLO|^HELO/.test(line)) socket.write(greetingReply(encrypted));
			else if (line === "STARTTLS") upgradeToTls();
			else if (line.startsWith("AUTH")) socket.write("235 Authenticated\r\n");
			else if (line.startsWith("MAIL FROM:")) {
				mailFrom.push(line);
				socket.write("250 OK\r\n");
			} else if (line.startsWith("RCPT TO"))
				socket.write(recipientReply(scenario, line));
			else if (line === "DATA") {
				data = [];
				socket.write("354 Send message\r\n");
			} else if (line === "QUIT") socket.end("221 Bye\r\n");
			else socket.write("250 OK\r\n");
		}

		function receive(chunk: Buffer) {
			buffer += chunk.toString();
			let newline = buffer.indexOf("\r\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 2);
				command(line);
				newline = buffer.indexOf("\r\n");
			}
		}

		function attach() {
			socket.on("data", receive);
			socket.on("error", () => {});
		}

		attach();
		socket.write("220 Isolated test SMTP\r\n");
	});

	t.after(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});

	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Test server has no TCP port.");
	return { port: address.port, messages, mailFrom };
}
