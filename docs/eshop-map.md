# eShop reference map for API testing

Reference for writing API tests against the eShop sample at `/workspaces/eShop`
(upstream commit `b4a4087`). All file paths in this document are relative to
`/workspaces/eShop` unless stated otherwise.

## Verification status

**Everything in this document is labelled `from source`.** Nothing could be
verified by request.

The task specified a base URL in `.env` as `CATALOG_API_URL`. There is no `.env`
file in this repo, and `CATALOG_API_URL` does not appear anywhere in either
repo. No eShop service was listening during this exploration — only the two
Aspire-managed containers `postgres-bf0f80a6` (host port 18180) and
`eventbus-bf0f80a6` (RabbitMQ, host port 18179) were up. The other local
listeners (16634–16636, 33061) are editor/tooling processes, not Catalog.

Claims below that are marked **[verify live]** are the ones where source reading
is genuinely not conclusive and a request would settle it. Once the AppHost is
running (`dotnet run --project src/eShop.AppHost`), those are the first things to
check.

---

## 1. Services

Aspire wires every resource in [`src/eShop.AppHost/Program.cs`](../../eShop/src/eShop.AppHost/Program.cs).
Infrastructure: `redis` (`:8`), `eventbus` = RabbitMQ (`:9-10`), `postgres` using
the `ankane/pgvector` image (`:11-14`). Four logical databases hang off that one
Postgres server: `catalogdb` (`:16`), `identitydb` (`:17`), `orderingdb` (`:18`),
`webhooksdb` (`:19`).

### Services with an inbound protocol

| Service | Purpose | Protocol | Datastore | Source |
|---|---|---|---|---|
| **Catalog.API** | Product catalog CRUD, filtering, pgvector semantic search, image serving. Also the stock-validation participant in the order saga. | HTTP REST, minimal APIs, versioned v1 + v2 | Postgres `catalogdb` via EF Core `CatalogContext` | `src/Catalog.API/Program.cs:21`; `src/Catalog.API/Extensions/Extensions.cs:15` |
| **Basket.API** | Per-user basket, keyed by authenticated user id. | **gRPC only** (Kestrel forced to HTTP/2) — there is no REST surface | Redis | `src/Basket.API/Program.cs:12`; `src/Basket.API/Extensions/Extensions.cs:14,16` |
| **Ordering.API** | Order management, CQRS/DDD with MediatR. All endpoints require auth. | HTTP REST, minimal APIs, v1 only | Postgres `orderingdb` via EF Core `OrderingContext` | `src/Ordering.API/Apis/OrdersApi.cs:9`; `src/Ordering.API/Extensions/Extensions.cs:15-19` |
| **Webhooks.API** | Webhook subscription registry; fans out HTTP POSTs on relevant events. Endpoints require auth. | HTTP REST, minimal APIs, v1 only | Postgres `webhooksdb` via EF Core `WebhooksContext` | `src/Webhooks.API/Apis/WebHooksApi.cs:11`; `src/Webhooks.API/Extensions/Extensions.cs:10` |
| **Identity.API** | Duende IdentityServer + ASP.NET Core Identity. Issues the tokens everything else consumes. | HTTP, MVC controllers + OIDC/OAuth2 endpoints | Postgres `identitydb` via EF Core `ApplicationDbContext` | `src/Identity.API/Program.cs:52,55`; `:7` |
| **WebApp** | Blazor Server storefront. | Blazor interactive server UI; also forwards `/product-images/{id}` to Catalog | none (state per circuit) | `src/WebApp/Program.cs:30,32` |
| **WebhookClient** | Demo app that registers webhook subscriptions and displays callbacks. | Blazor UI + `POST /webhook-received`, `POST /logout` | in-memory `ConcurrentQueue` | `src/WebhookClient/Endpoints/WebhookEndpoints.cs:31` |
| **mobile-bff** | YARP reverse proxy exposing Catalog / Ordering / Identity to mobile clients. | HTTP proxy | none | `src/eShop.AppHost/Program.cs:61-63`; routes in `src/eShop.AppHost/Extensions.cs:87-152` |

### Background workers (no business API — health endpoints only)

| Service | Purpose | Datastore | Source |
|---|---|---|---|
| **OrderProcessor** | Polls for `Submitted` orders past their grace period and confirms them. | Postgres `orderingdb` via **raw Npgsql**, no EF Core | `src/OrderProcessor/Extensions/Extensions.cs:13,19`; SQL at `src/OrderProcessor/Services/GracePeriodOrdersRepository.cs:12-29` |
| **PaymentProcessor** | Simulated payment gateway. Succeeds or fails based on the `PaymentOptions.PaymentSucceeded` flag. | none | `src/PaymentProcessor/Program.cs:5-9,13` |

### Client apps and libraries (not services)

- **ClientApp** — .NET MAUI native client; gRPC client of Basket, HTTP client of the BFF (`src/ClientApp/ClientApp.csproj:4,18`).
- **HybridApp** — MAUI Blazor Hybrid; points at the BFF on port 11632 (`src/HybridApp/MauiProgram.cs:9,30`).
- **EventBus** — broker-agnostic abstractions, `IEventBus` / `IntegrationEvent` (`src/EventBus/Abstractions/IEventBus.cs:5`).
- **EventBusRabbitMQ** — the RabbitMQ transport (`src/EventBusRabbitMQ/RabbitMQEventBus.cs`).
- **IntegrationEventLogEF** — the transactional outbox (`src/IntegrationEventLogEF/`).
- **Ordering.Domain** / **Ordering.Infrastructure** — DDD model and its EF persistence.
- **WebAppComponents** — Razor class library shared by WebApp and HybridApp.
- **Shared** — two files linked by `<Compile Include>`; there is no `.csproj`.
- **eShop.ServiceDefaults** — OTel, health checks, service discovery, JWT defaults, OpenAPI/Scalar setup.
- **eShop.AppHost** — the Aspire orchestrator.

### Integration events

Every event class is **duplicated per service**; correlation across services is by
CLR type *short name* only — `o.EventTypes[typeof(T).Name] = typeof(T)` at
`src/EventBus/Extensions/EventBusBuilderExtensions.cs:35`. Renaming a record on
one side breaks routing with nothing louder than a warning log.

| Event | Published by | Consumed by |
|---|---|---|
| `ProductPriceChangedIntegrationEvent` | Catalog.API `Apis/CatalogApi.cs:395,401` | Webhooks.API `Extensions/Extensions.cs:21` — **handler is a no-op** |
| `OrderStartedIntegrationEvent` | Ordering.API `Application/Commands/CreateOrderCommandHandler.cs:32-33` | Basket.API `Extensions/Extensions.cs:19` (deletes the basket) |
| `OrderStatusChangedToSubmittedIntegrationEvent` | Ordering.API `…/ValidateOrAddBuyerAggregateWhenOrderStartedDomainEventHandler.cs:50-51` | WebApp `Extensions/Extensions.cs:50` |
| `OrderStatusChangedToAwaitingValidationIntegrationEvent` | Ordering.API `…/OrderStatusChangedToAwaitingValidationDomainEventHandler.cs:33-34` | Catalog.API `Extensions/Extensions.cs:32`; WebApp `Extensions/Extensions.cs:45` |
| `OrderStockConfirmedIntegrationEvent` | Catalog.API `…/OrderStatusChangedToAwaitingValidationIntegrationEventHandler.cs:29,32` | Ordering.API `Extensions/Extensions.cs:56` |
| `OrderStockRejectedIntegrationEvent` | Catalog.API `…/OrderStatusChangedToAwaitingValidationIntegrationEventHandler.cs:28,32` | Ordering.API `Extensions/Extensions.cs:57` |
| `OrderStatusChangedToStockConfirmedIntegrationEvent` | Ordering.API `…/OrderStatusChangedToStockConfirmedDomainEventHandler.cs:30-31` | PaymentProcessor `Program.cs:6`; WebApp `Extensions/Extensions.cs:47` |
| `OrderPaymentSucceededIntegrationEvent` | PaymentProcessor `…/OrderStatusChangedToStockConfirmedIntegrationEventHandler.cs:23,32` | Ordering.API `Extensions/Extensions.cs:59` |
| `OrderPaymentFailedIntegrationEvent` | PaymentProcessor `…/OrderStatusChangedToStockConfirmedIntegrationEventHandler.cs:27,32` | Ordering.API `Extensions/Extensions.cs:58` |
| `OrderStatusChangedToPaidIntegrationEvent` | Ordering.API `…/OrderStatusChangedToPaidDomainEventHandler.cs:32,39` | Catalog.API `Extensions/Extensions.cs:33` (removes stock); Webhooks.API `Extensions/Extensions.cs:23`; WebApp `Extensions/Extensions.cs:46` |
| `OrderStatusChangedToShippedIntegrationEvent` | Ordering.API `…/OrderShippedDomainEventHandler.cs:30-31` | Webhooks.API `Extensions/Extensions.cs:22`; WebApp `Extensions/Extensions.cs:48` |
| `OrderStatusChangedToCancelledIntegrationEvent` | Ordering.API `…/OrderCancelledDomainEventHandler.cs:30-31` | WebApp `Extensions/Extensions.cs:49` |
| `GracePeriodConfirmedIntegrationEvent` | OrderProcessor `Services/GracePeriodManagerService.cs:56,60` | Ordering.API `Extensions/Extensions.cs:55` |

Catalog.API publishes three events and consumes two. Basket.API publishes none.
Identity.API, WebhookClient, ClientApp and HybridApp touch the bus not at all.

---

## 2. Catalog API endpoints

*from source* — routes from [`src/Catalog.API/Apis/CatalogApi.cs:12-119`](../../eShop/src/Catalog.API/Apis/CatalogApi.cs#L12-L119),
response codes cross-checked against the build-time OpenAPI documents
`src/Catalog.API/Catalog.API.json` (v1) and `src/Catalog.API/Catalog.API_v2.json` (v2).

All routes are under `api/catalog`. `api-version` is a **required query parameter
on every one of them** (see §3).

| Method | Route | Handler | Versions | Parameters / body | Responses |
|---|---|---|---|---|---|
| GET | `/items` | `GetAllItemsV1` (`:122`) | 1.0 | `PageSize` (q, default 10), `PageIndex` (q, default 0) | 200 `PaginatedItems<CatalogItem>`, 400 |
| GET | `/items` | `GetAllItems` (`:130`) | 2.0 | `PageSize`, `PageIndex`, `name` (prefix match), `type` (repeatable int), `brand` (repeatable int) | 200, 400 |
| GET | `/items/by` | `GetItemsByIds` (`:207`) | 1.0, 2.0 | `ids` (q, repeatable int) | 200 `List<CatalogItem>`, 400 |
| GET | `/items/{id:int}` | `GetItemById` (`:216`) | 1.0, 2.0 | `id` (path) | 200 `CatalogItem`, **400 if `id <= 0`** (`:221-226`), 404 |
| GET | `/items/by/{name:minlength(1)}` | `GetItemsByName` (`:239`) | **1.0 only** | `name` (path), `PageSize`, `PageIndex` | 200, 400 |
| GET | `/items/{id:int}/pic` | `GetItemPictureById` (`:250`) | 1.0, 2.0 | `id` (path) | 200 (image, MIME from extension `:451-463`), 404 |
| GET | `/items/facets` | `GetCatalogFacets` (`:168`) | 1.0, 2.0 | `type` (repeatable), `brand` (repeatable) | 200 `CatalogFacets` — **200 only, no 400 declared** |
| GET | `/items/withsemanticrelevance/{text:minlength(1)}` | `GetItemsBySemanticRelevanceV1` (`:272`) | **1.0 only** | `text` (path), `PageSize`, `PageIndex` | 200, 400 |
| GET | `/items/withsemanticrelevance` | `GetItemsBySemanticRelevance` (`:282`) | **2.0 only** | `text` (q, required, minlength 1), `PageSize`, `PageIndex` | 200, 400 |
| GET | `/items/type/{typeId}/brand/{brandId?}` | `GetItemsByBrandAndTypeId` (`:337`) | **1.0 only** | `typeId` (path), `brandId` (path, optional in route) | 200, 400 |
| GET | `/items/type/all/brand/{brandId:int?}` | `GetItemsByBrandId` (`:347`) | **1.0 only** | `brandId` (path, optional) | 200, 400 |
| GET | `/catalogtypes` | inline lambda (`:83-85`) | 1.0, 2.0 | — | 200 `List<CatalogType>`, 400 |
| GET | `/catalogbrands` | inline lambda (`:90-92`) | 1.0, 2.0 | — | 200 `List<CatalogBrand>`, 400 |
| PUT | `/items` | `UpdateItemV1` (`:355`) | **1.0 only** | body: `CatalogItem` (id taken from the body) | **201** + `Location`, 400, 404 |
| PUT | `/items/{id:int}` | `UpdateItem` (`:369`) | **2.0 only** | `id` (path), body: `CatalogItem` | **201** + `Location`, 400, 404 |
| POST | `/items` | `CreateItem` (`:411`) | 1.0, 2.0 | body: `CatalogItem` (client supplies `Id`) | 201 + `Location`, 400 |
| DELETE | `/items/{id:int}` | `DeleteItemById` (`:435`) | 1.0, 2.0 | `id` (path) | 204, 404 |

### Request body — `CatalogItem`

`src/Catalog.API/Model/CatalogItem.cs:7-47`. JSON is camelCase.

```
id            int       required by the DB, client-assigned on POST
name          string    [Required], DB column max length 50
description   string?
price         decimal
pictureFileName string?
catalogTypeId int
catalogBrandId int
availableStock int
restockThreshold int
maxStockThreshold int
onReorder     bool
```

`embedding` is `[JsonIgnore]` (`:39-40`) so it never appears in responses.
`catalogType` / `catalogBrand` are navigation properties; `catalogBrand` is
eager-loaded by `GetAllItems` (`:159`) and `GetItemById` (`:228`) but **not** by
`GetItemsByIds` (`:211`) — so the same item serialises differently depending on
which endpoint returned it.

### Response envelope — `PaginatedItems<T>`

`src/Catalog.API/Model/PaginatedItems.cs:5-14`: `pageIndex`, `pageSize`, `count`
(total, `long`), `data` (array). Note `count` is the **total matching rows**, not
the length of `data`.

---

## 3. Versioning

*from source*

**How the version is passed.** As a **query string parameter named `api-version`**.
`AddApiVersioning` is called at `src/Catalog.API/Program.cs:7-11` and configures
only `ReportApiVersions = true`. No `ApiVersionReader` is set anywhere in the
repo, so Asp.Versioning's default reader applies — a grep for
`ApiVersionReader`, `AssumeDefaultVersionWhenUnspecified`, `DefaultApiVersion`
and `ApiVersionSelector` across `src/` and `tests/` returns nothing but an
unrelated OpenAPI description string. The default parameter name `api-version` is
present as a literal in `Asp.Versioning.Http.dll` (v10.0.0-preview.2). The
generated OpenAPI documents list `api-version` as a **required query parameter on
every operation**, in both v1 and v2.

Header and media-type versioning are **not** configured. There is no URL-segment
versioning either — the version is never in the path.

Because `ReportApiVersions = true`, successful responses carry
`api-supported-versions: 1.0, 2.0` (and `api-deprecated-versions` when
applicable).

**No version sent → 400.** `AssumeDefaultVersionWhenUnspecified` is left at its
default of `false`, so an unversioned request is rejected rather than falling
back to v1. The checked-in `src/Catalog.API/Catalog.API.http:16-18` states this
explicitly: *"api-version is required, so this request will fail"*. The response
is a ProblemDetails with `type: https://docs.api-versioning.org/problems#unspecified`.

**Unsupported version → 400.** `src/Catalog.API/Catalog.API.http:30-32`:
*"A request with an unknown API version returns a 400 ProblemDetails response"*,
demonstrated with `?api-version=99`. `type` is
`https://docs.api-versioning.org/problems#unsupported`. The status code comes
from `UnsupportedApiVersionStatusCode`, which is left at its default of 400.

Two related problem types exist in the same assembly and are worth knowing about:
`#invalid` (malformed version string, e.g. `?api-version=abc`) and `#ambiguous`
(the same version supplied twice with different values).

**Version-specific routing is real, not cosmetic.** Requesting a route with the
wrong version is a routing miss, not a 404-by-id. `GET /items/by/Alpine?api-version=2.0`
hits a route that only has `HasApiVersion(1, 0)` (`CatalogApi.cs:41`), so expect
the unsupported/unmatched-version 400 rather than a 200 or a plain 404.
**[verify live]** — confirm whether that specific shape returns 400 or 404.

**The BFF is stricter than the API.** The YARP routes in
`src/eShop.AppHost/Extensions.cs:96-142` match `api-version` against an exact
value list. Most catalog routes accept `["1.0", "1", "2.0"]` — note that **`"2"`
is not in the list**, while `"1"` is. The v1-only routes (`/items/by/{name}`,
`/items/withsemanticrelevance/{text}`, `/items/type/...`) accept only
`["1.0", "1"]`, and `/items/withsemanticrelevance` accepts only `["2.0"]`. A
request with `?api-version=2` through the BFF fails to match any route and gets a
404 from YARP, whereas the same request straight to Catalog would be accepted as
version 2.0. If your tests go through the BFF, use the exact strings `1.0` or
`2.0`.

---

## 4. OpenAPI

*from source*

**Where documents are generated.** Two ways, and they produce the same content:

1. **At build time**, into the project directory. `src/Catalog.API/Catalog.API.csproj:14-16`
   sets `<OpenApiDocumentsDirectory>$(MSBuildProjectDirectory)</OpenApiDocumentsDirectory>`
   and `:26-29` references `Microsoft.Extensions.ApiDescription.Server`. The
   results are committed: `src/Catalog.API/Catalog.API.json` (v1) and
   `src/Catalog.API/Catalog.API_v2.json` (v2), both OpenAPI 3.1.1. Build-time
   generation runs the app in a `Build` environment, which short-circuits the
   real database registration — `src/Catalog.API/Extensions/Extensions.cs:9-13`
   with the check at `src/Catalog.API/Extensions/HostEnvironmentExtensions.cs:7-13`.
   **These committed files are a reliable offline contract to test against.**
2. **At runtime**, via `app.UseDefaultOpenApi()` (`src/Catalog.API/Program.cs:23`)
   → `app.MapOpenApi().WithDocumentPerVersion()` at
   `src/eShop.ServiceDefaults/OpenApi.Extensions.cs:24`. Document names come from
   the API-explorer group name format `"'v'VVV"` set at
   `src/eShop.ServiceDefaults/OpenApi.Extensions.cs:70`, giving `v1` and `v2`.

**URLs.**

| URL | Serves |
|---|---|
| `/openapi/v1.json` | v1 document |
| `/openapi/v2.json` | v2 document |
| `/scalar/v1`, `/scalar/v2` | Scalar UI, **development environment only** |
| `/` | redirects to `/scalar/{default}`, where default is the **last** version description — i.e. `/scalar/v2` |

The first two are confirmed by the checked-in
`src/Catalog.API/Catalog.API.http:4,8`; Scalar and the root redirect by
`src/eShop.ServiceDefaults/OpenApi.Extensions.cs:26-42`, which is gated on
`app.Environment.IsDevelopment()`.

All of this is gated on an `OpenApi` configuration section existing
(`OpenApi.Extensions.cs:19-22` and `:59-62`). Catalog defines one at
`src/Catalog.API/appsettings.json:8-17`, so OpenAPI is on. Document title and
description come from that section; `Info.Version` is overwritten per document
with the actual API version at `src/eShop.ServiceDefaults/OpenApiOptionsExtensions.cs:27`
— which is why `appsettings.json` says `"Version": "v1"` but the v2 document
reports `2.0`.

**Do not trust the documents blindly.** `/items/type/{typeId}/brand/{brandId}` is
declared with `brandId` **required** in `Catalog.API.json`, but the route is
`{brandId?}` and the handler takes `int?` (`CatalogApi.cs:73`, `:341`). The
document is wrong about that parameter.

---

## 5. Cross-service flow: a catalog item's price changes

*from source*

**Short version: this flow is a dead end.** The only subscriber is Webhooks.API,
and its handler does nothing. No basket is updated, no onward event is published,
no user-facing notification fires. The storefront shows the new price only
because it re-reads Catalog over HTTP at render time.

**1 — The update handler.** `CatalogApi.UpdateItem` at `CatalogApi.cs:369-408`
(v2 route; v1 delegates to it from `:366`):

- Load the tracked entity, 404 if missing (`:375-382`).
- `catalogEntry.CurrentValues.SetValues(productToUpdate)` copies the whole body
  onto the tracked entity (`:385-386`).
- Recompute the AI embedding (`:388`).
- **Detection is pure EF change tracking**: `priceEntry.IsModified` (`:390-392`).
  Submitting the *same* price produces no event at all.
- Build `new ProductPriceChangedIntegrationEvent(catalogItem.Id, productToUpdate.Price, priceEntry.OriginalValue)`
  (`:395`) — new price from the request body, old price from what was loaded from
  the DB.
- `SaveEventAndCatalogContextChangesAsync` (`:398`), then
  `PublishThroughEventBusAsync` (`:401`).
- Return **201 Created** with a `Location` header (`:407`).

**2 — Transactional outbox.** `src/Catalog.API/IntegrationEvents/CatalogIntegrationEventService.cs`.

- Phase A (`:28-40`) runs inside `ResilientTransaction`
  (`src/IntegrationEventLogEF/Utilities/ResilientTransaction.cs:152-163`): the
  price row and the outbox row commit **atomically**, because the
  `IntegrationEventLog` table lives in the same `catalogdb`
  (`src/Catalog.API/Infrastructure/CatalogContext.cs:26`). The log service
  enlists the caller's transaction at
  `src/IntegrationEventLogEF/Services/IntegrationEventLogService.cs:40`.
- Phase B (`:11-26`) runs **outside** the transaction:
  `MarkEventAsInProgressAsync` (increments `TimesSent`) → `eventBus.PublishAsync`
  → `MarkEventAsPublishedAsync`. The `catch` at `:21-25` marks the row
  `PublishedFailed`, logs, and **swallows the exception — the request still
  returns 201**.
- States (`src/IntegrationEventLogEF/EventStateEnum.cs`): `NotPublished=0`,
  `InProgress=1`, `Published=2`, `PublishedFailed=3`.
- **There is no retry worker.** `RetrieveEventLogsPendingToPublishAsync`
  (`IntegrationEventLogService.cs:19-32`) has no caller anywhere in `src/`. A
  failed publish is lost permanently and silently.

**3 — Transport.** `src/EventBusRabbitMQ/RabbitMQEventBus.cs`.

- Exchange `eshop_event_bus` (`:20`), type `direct` (`:47-49`).
- **Routing key is the CLR type short name** — `@event.GetType().Name` (`:33`),
  literally `ProductPriceChangedIntegrationEvent`.
- Messages are persistent (`:77`) and published `mandatory: true` (`:100`), but
  **publisher confirms are not enabled** — a 201 does not prove the broker took
  the message.
- Publish retries on `BrokerUnreachableException` / `SocketException` up to
  `RetryCount` (default **10**, `src/EventBusRabbitMQ/EventBusOptions.cs:6`) with
  `2^attempt` second backoff (`:302-320`) — worst case roughly **34 minutes,
  inline in the HTTP request**.
- One durable queue per service, named from `EventBus:SubscriptionClientName`
  (`:258-263`); Catalog's is `Catalog` (`src/Catalog.API/appsettings.json:21-23`),
  the subscriber here is `Webhooks`.
- Consumers use `autoAck: false` (`:274-277`) but
  **`BasicAckAsync` runs unconditionally even after a handler throws** (`:180`),
  with the source comment at `:177-179` acknowledging there is no dead-letter
  exchange. A failing handler drops the message with a warning log and nothing else.

**4 — Consumers.** Exactly one, and it does nothing:
`Webhooks.API.IntegrationEvents.ProductPriceChangedIntegrationEventHandler`,
registered at `src/Webhooks.API/Extensions/Extensions.cs:21`, body is
`return Task.CompletedTask;` at
`src/Webhooks.API/IntegrationEvents/ProductPriceChangedIntegrationEventHandler.cs:7`.

Explicitly **not** consumers, all verified:
- **Basket.API** subscribes only to `OrderStartedIntegrationEvent`
  (`src/Basket.API/Extensions/Extensions.cs:19`). There is no Redis basket price
  update in this codebase — `CustomerBasket` holds only `BuyerId` and items
  (`src/Basket.API/Model/CustomerBasket.cs:5-7`), and the gRPC mapping carries
  only `ProductId` and `Quantity` (`src/Basket.API/Grpc/BasketService.cs:85-86,104-105`).
  `BasketItem.UnitPrice` / `OldUnitPrice` (`src/Basket.API/Model/BasketItem.cs:23-24`)
  are never populated or persisted.
- **Ordering.API** (`src/Ordering.API/Extensions/Extensions.cs:55-59`), **WebApp**
  (`src/WebApp/Extensions/Extensions.cs:45-50`), **PaymentProcessor**, **OrderProcessor** — order/payment events only.

**5 — Onward events.** None. The chain terminates one hop after Catalog.

**6 — What the user sees.** The new price, via synchronous reads of Catalog:

- Catalog listing and item pages read `CatalogContext` directly, so the new price
  is visible on the very next request after the 201 — strongly consistent.
- The cart page fetches **quantities** from Basket, then calls
  `catalogService.GetCatalogItems(productIds)` and sets `UnitPrice = catalogItem.Price`
  from the live Catalog response (`src/WebApp/Services/BasketState.cs:123,132,141`).
  Rendered at `src/WebApp/Components/Pages/Cart/CartPage.razor:46,79,123`.
- `BasketState.cs:119` memoises per scoped instance (`_cachedBasket ??= …`), so an
  already-rendered page keeps the old price until the next load or a basket mutation.
- There is **no** "price changed" banner and no strike-through.
  `src/WebApp/Services/BasketItem.cs:9` declares `OldUnitPrice`; nothing ever writes it.

The webhook path that *was* intended exists but is disconnected:
`WebhookType.CatalogItemPriceChange = 1` is defined in both
`src/Webhooks.API/Model/WebhookType.cs:5` and `src/WebhookClient/Services/WebhookType.cs:5`,
and the sibling `OrderStatusChangedToPaidIntegrationEventHandler.cs:16-25` shows
what a working handler looks like. It never fires for price changes.

---

## 6. Testing notes

*from source unless marked*

### Auth

**Catalog.API is unauthenticated.** `src/Catalog.API/appsettings.json` has no
`Identity` section, and `AddDefaultAuthentication` returns early without one
(`src/eShop.ServiceDefaults/AuthenticationExtensions.cs:22-28`). The AppHost sets
`Identity__Url` on basket-api (`:34`), ordering-api (`:45`) and webhooks-api
(`:58`) but **deliberately not on catalog-api** (`src/eShop.AppHost/Program.cs:37-39`).
No `RequireAuthorization()` appears anywhere in `CatalogApi.cs`. So every Catalog
endpoint — including `PUT`, `POST` and `DELETE` — is open. Ordering.API and
Webhooks.API, by contrast, call `RequireAuthorization()` on the whole group
(`src/Ordering.API/Program.cs:22`, `src/Webhooks.API/Program.cs:21`) and need a
bearer token from Identity.

### Unusual status codes

- **`PUT` returns 201 Created, not 200 or 204** (`CatalogApi.cs:407`), even when
  updating an existing item. Do not assert 200.
- The `Location` header is `/api/catalog/items/{id}` with **no `?api-version=`**.
  Following it verbatim will 400. Append the version yourself.
- **`GET /items/0` → 400, but `DELETE /items/0` → 404.** `GetItemById` has an
  explicit `id <= 0` guard (`:221-226`); `DeleteItemById` (`:435-449`) has none, so
  a non-positive id just misses in the database. The functional tests pin both:
  `tests/Catalog.FunctionalTests/CatalogApiTests.cs:427-434` and `:439-449`.
- `/items/facets` declares **only 200** in both OpenAPI documents — no 400 — because
  `GetCatalogFacets` (`:168`) carries no `[ProducesResponseType]` attribute. It
  will still 400 on a missing `api-version`; the document just doesn't say so.
- `GET /items/{id}/pic` returns 404 when the item is missing *or* `PictureFileName`
  is null (`:257-260`), but if the row has a filename and the file is absent from
  disk, `TypedResults.PhysicalFile` will throw rather than 404. **[verify live]**
- `app.UseStatusCodePages()` is registered at `src/Catalog.API/Program.cs:19`, which
  normally adds a `text/plain` body to bodiless 4xx/5xx responses. But
  `src/Catalog.API/Catalog.API.http:36` claims *"404 NotFound with empty response
  body"*. **[verify live]** — check whether 404s actually carry a body before
  asserting on it.

### Validation gaps

- **`Name` is capped at 50 characters by the DB** (`src/Catalog.API/Infrastructure/EntityConfigurations/CatalogItemEntityTypeConfiguration.cs`,
  `HasMaxLength(50)`) with no request-side validation. Minimal APIs do not run
  DataAnnotations by default, so the `[Required]` on `CatalogItem.Name`
  (`Model/CatalogItem.cs:11`) is not enforced either. A 51-character name should
  surface as a database error, not a 400. **[verify live]** — worth confirming
  whether that is a 500.
- **`POST /items` accepts a client-supplied `Id`** (`CatalogApi.cs:418`). Posting an
  id that already exists is a primary-key violation, again not a 400.
  **[verify live]**
- **`UpdateItemV1`'s guard is nearly dead code.** `CatalogApi.cs:360` tests
  `productToUpdate?.Id == null`, but `Id` is a non-nullable `int`, so for any
  non-null body the comparison is always false. The 400 *"Item id must be provided
  in the request body"* is reachable only by sending a literal JSON `null` body.
  `PUT /items` with `{"id": 0, ...}` falls through to `UpdateItem` and returns
  **404**, not 400.
- No bounds checking on `PageSize` or `PageIndex` (`Model/PaginationRequest.cs`).
  A negative `PageSize` reaches `Skip(pageSize * pageIndex).Take(pageSize)` at
  `CatalogApi.cs:161-162`. **[verify live]** — likely a 500 from the provider.
  A `PageIndex` past the end is well-behaved and returns empty `data`
  (`tests/Catalog.FunctionalTests/CatalogApiTests.cs:454-468`).
- `GET /items/by` with no `ids` parameter: the OpenAPI document marks `ids`
  required, but minimal-API array binding generally yields an empty array rather
  than a 400, which would give `200 []`. **[verify live]**
- `GetItemsBySemanticRelevance` silently degrades to a name prefix search when AI
  is disabled or the embedding call returns null (`CatalogApi.cs:290-301`). With no
  embedding model configured, "semantic search" is really
  `Name.StartsWith(text)`. Do not write relevance assertions that assume vectors.

### Shared and persistent state

This is the biggest source of cross-run flakiness.

- **Postgres and RabbitMQ containers are `ContainerLifetime.Persistent`**
  (`src/eShop.AppHost/Program.cs:10,14`). They survive AppHost restarts, so
  `catalogdb` keeps whatever your last test run did to it.
- **The seeder is a no-op once data exists**:
  `src/Catalog.API/Infrastructure/CatalogContextSeed.cs:23` is
  `if (!context.CatalogItems.Any())`. Deleting or mutating items is permanent
  until you drop the volume. Baseline seed is **101 items** from
  `src/Catalog.API/Setup/catalog.json`, **13 brands** and **8 types** (counts
  asserted at `tests/Catalog.FunctionalTests/CatalogApiTests.cs:332,352`), with
  `AvailableStock = 100`, `MaxStockThreshold = 200`, `RestockThreshold = 10` and
  `PictureFileName = "{id}.webp"` (`CatalogContextSeed.cs:55-58`).
- All four logical databases share **one Postgres server** — noisy tests in one
  service can affect another's performance.
- **The upstream functional tests already mutate the shared seed**: they change
  item 1's price to 1.99 and decrement its stock
  (`tests/Catalog.FunctionalTests/CatalogApiTests.cs:96-105`), **delete items 5 and
  6** (`:405-413`), and insert ids 10015/10016 (`:363-384`). If you run them against
  a shared database, later assertions on those ids will drift. Pick ids outside
  1–101 and outside 10015/10016 for your own writes. Note also that
  `tests/Catalog.FunctionalTests/CatalogApiFixture.cs:21-24` spins up its **own**
  throwaway Postgres and no RabbitMQ.
- Catalog.API's outbox lives in `catalogdb` as the `IntegrationEventLog` table
  (`src/IntegrationEventLogEF/IntegrationLogExtensions.cs`), primary key `EventId`.
  It is a good assertion target — see below.

### Testing the price-change flow specifically

- Publishing is `await`ed **before** the 201 is returned (`CatalogApi.cs:398,401,407`),
  so the DB commit and the publish *call* are done when you get the response. That
  is not the same as delivery: no publisher confirms, and no consumer ack.
- Because publish failures are swallowed (`CatalogIntegrationEventService.cs:21-25`),
  **a 201 tells you nothing about the event**. Assert on the `IntegrationEventLog`
  row's `State` (2 = `Published`) instead.
- `TimesSent > 1` indicates a republish attempt
  (`IntegrationEventLogService.cs:66-67`) — a useful handle.
- Clean negative path: PUT with an unchanged price writes **zero** outbox rows
  (`CatalogApi.cs:392,403-405`).
- Cold-start race: `RabbitMQEventBus.StartAsync` spawns a background task and
  returns immediately (`:229,294`); queue declare and bind happen at `:258-285`.
  Publishing before Webhooks has bound its queue means the direct exchange drops
  the message. Wait for the binding, not just for the process.
- If RabbitMQ is unreachable the PUT can block for tens of minutes inside the Polly
  pipeline before returning 201. Set aggressive client timeouts, or lower
  `EventBus:RetryCount`.
- `CatalogApi.cs:388` calls the embedding generator on **every** update, before the
  event is created. With a real Ollama/Foundry model configured
  (`src/Catalog.API/Extensions/Extensions.cs:38-47`) that adds latency and a failure
  mode on the write path.
- Asserting on consumer behaviour is currently vacuous — the handler is empty. The
  only meaningful end-to-end assertions are the outbox row and its state, a message
  landing on the `Webhooks` queue with routing key
  `ProductPriceChangedIntegrationEvent`, and the new price on a subsequent GET.

### Miscellaneous

- **Basket cannot be tested over REST.** It is gRPC-only on HTTP/2
  (`src/Basket.API/Program.cs:12`, plus the Kestrel `Protocols: Http2` override in
  `src/Basket.API/appsettings.json`). Plain HTTP/1.1 requests get
  *"An HTTP/1.x request was sent to an HTTP/2 only endpoint."*
- **Catalog has no external endpoint of its own.** `catalogApi` in
  `src/eShop.AppHost/Program.cs:37-39` does not call `.WithExternalHttpEndpoints()`
  — unlike identity-api (`:25`), mobile-bff (`:62`) and webapp (`:71`). Reach
  Catalog on its Aspire-assigned localhost port, or through the `mobile-bff` proxy
  (remembering the stricter version matching in §3).
- `/health` and `/alive` are mapped **only in the Development environment**
  (`src/eShop.ServiceDefaults/Extensions.cs:115-125`).
- The RabbitMQ connection name is inconsistently cased: `"eventbus"` in
  Catalog/Basket/Ordering/Webhooks/OrderProcessor, but `"EventBus"` in
  `src/PaymentProcessor/Program.cs:5` and `src/WebApp/Extensions/Extensions.cs:17`.
- WebApp's own catalog client pins **api-version 2.0**, while its ordering client
  pins 1.0 (`src/WebApp/Extensions/Extensions.cs:34,38`). v2 is the version the
  storefront actually exercises.
- `src/Catalog.API/Catalog.API.http` is a ready-made set of example requests,
  including the negative version cases, against `http://localhost:5222`.
