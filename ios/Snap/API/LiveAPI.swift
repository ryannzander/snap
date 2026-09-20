import Foundation

/// Talks to the deployed Worker over `URLSession`.
struct LiveAPI: SnapAPI {
    let baseURL: URL
    let token: String?
    let debugKey: String

    // MARK: - SnapAPI

    func onboard(_ body: OnboardRequest) async throws -> OnboardResponse {
        try await decode(try make(.post, "onboard", body: body, auth: false))
    }

    func postWorkouts(_ workouts: [WorkoutDTO]) async throws {
        struct Body: Encodable { let workouts: [WorkoutDTO] }
        _ = try await send(try make(.post, "workouts", body: Body(workouts: workouts)))
    }

    func state() async throws -> SnapState {
        try await decode(try make(.get, "state"))
    }

    func wallet() async throws -> Wallet {
        try await decode(try make(.get, "wallet"))
    }

    func topUp(sol: Double) async throws -> Wallet {
        struct Body: Encodable { let sol: Double }
        return try await decode(try make(.post, "wallet/topup", body: Body(sol: sol)))
    }

    func trace(since: Int?) async throws -> [TraceEvent] {
        let query = since.map { [URLQueryItem(name: "since", value: String($0))] } ?? []
        let response: TraceResponse = try await decode(try make(.get, "trace", query: query))
        return response.events
    }

    func timewarp(to date: Date?) async throws {
        _ = try await send(try make(.post, "debug/timewarp", body: TimewarpBody(now: date), debug: true))
    }

    func seed() async throws {
        _ = try await send(try make(.post, "debug/seed", debug: true))
    }

    func forget() async throws {
        _ = try await send(try make(.post, "debug/forget", debug: true))
    }

    // MARK: - Plumbing

    private enum Method: String { case get = "GET", post = "POST" }

    /// `/debug/timewarp` needs an explicit `null` to reset the clock, and the synthesized
    /// `Encodable` for an optional omits the key instead.
    private struct TimewarpBody: Encodable {
        let now: Date?

        enum CodingKeys: String, CodingKey { case now }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            if let now {
                try container.encode(now, forKey: .now)
            } else {
                try container.encodeNil(forKey: .now)
            }
        }
    }

    private func make(
        _ method: Method,
        _ path: String,
        query: [URLQueryItem] = [],
        body: (any Encodable)? = nil,
        auth: Bool = true,
        debug: Bool = false
    ) throws -> URLRequest {
        var components = URLComponents(
            url: baseURL.appending(path: path),
            resolvingAgainstBaseURL: false
        )
        if !query.isEmpty { components?.queryItems = query }
        guard let url = components?.url else {
            throw APIError(status: -1, body: "bad url for /\(path)")
        }

        var request = URLRequest(url: url)
        request.httpMethod = method.rawValue
        request.timeoutInterval = 15
        if auth, let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if debug { request.setValue(debugKey, forHTTPHeaderField: "X-Debug-Key") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try Self.encoder.encode(body)
        }
        return request
    }

    @discardableResult
    private func send(_ request: URLRequest) async throws -> Data {
        try await exchange(request).data
    }

    private func exchange(_ request: URLRequest) async throws -> (data: Data, status: Int) {
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? -1
        guard (200..<300).contains(status) else {
            throw APIError(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return (data, status)
    }

    private func decode<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, status) = try await exchange(request)
        do {
            return try Self.decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decodeFailure(status: status, type: T.self, underlying: error)
        }
    }

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(ISO8601.string(from: date))
        }
        return encoder
    }()

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let raw = try decoder.singleValueContainer().decode(String.self)
            guard let date = ISO8601.date(from: raw) else {
                throw DecodingError.dataCorrupted(
                    .init(codingPath: decoder.codingPath, debugDescription: "not ISO 8601: \(raw)")
                )
            }
            return date
        }
        return decoder
    }()
}
