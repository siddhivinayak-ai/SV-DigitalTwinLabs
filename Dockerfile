# syntax=docker/dockerfile:1
# Single image: builds the web console, publishes the API, serves both on :8080.

FROM node:22-alpine AS ui
WORKDIR /src
COPY contracts/ contracts/
COPY ui/package.json ui/package-lock.json ui/
RUN cd ui && npm ci
COPY ui/ ui/
RUN mkdir -p server/src/TwinLabs.Api && cd ui && npm run build

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS api
WORKDIR /src
COPY contracts/ contracts/
COPY server/ server/
COPY --from=ui /src/server/src/TwinLabs.Api/wwwroot server/src/TwinLabs.Api/wwwroot
RUN dotnet publish server/src/TwinLabs.Api -c Release -o /app

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=api /app .
ENV ASPNETCORE_URLS=http://+:8080 \
    DOTNET_CLI_TELEMETRY_OPTOUT=1
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:8080/api/health || exit 1
ENTRYPOINT ["dotnet", "TwinLabs.Api.dll"]
