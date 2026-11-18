# =========================================================================
# Etapa 1: Compilación (Builder) con Node 24 y PNPM
# =========================================================================
FROM node:24-alpine AS builder

WORKDIR /usr/src/app

# Instalar dependencias de sistema para módulos nativos (bcrypt, etc.)
RUN apk add --no-cache python3 make g++

# Instalar PNPM de forma global
RUN npm install -g pnpm

# Copiar manifiestos de dependencias y scripts de validación
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml* ./
COPY scripts/ ./scripts/

# Instalar todas las dependencias con PNPM para compilar TypeScript y binarios nativos
RUN pnpm install --no-frozen-lockfile

# Copiar el código fuente completo
COPY . .

# Compilar la aplicación NestJS con PNPM
RUN pnpm run build

# =========================================================================
# Etapa 2: Imagen de Producción Ligera y Segura con Node 24 y PNPM
# =========================================================================
FROM node:24-alpine AS runner

WORKDIR /usr/src/app

ENV NODE_ENV=production

# Instalar PNPM de forma global
RUN npm install -g pnpm

# Copiar manifiestos
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml* ./
COPY scripts/ ./scripts/

# Instalar exclusivamente dependencias de producción con PNPM
RUN pnpm install --prod --no-frozen-lockfile && pnpm store prune

# Copiar la aplicación compilada desde la etapa de compilación
COPY --from=builder /usr/src/app/dist ./dist

# Crear directorios de uploads y storage con permisos para el usuario 'node' (UID 1000)
RUN mkdir -p uploads storage && chown -R node:node /usr/src/app/uploads /usr/src/app/storage

# Declarar volumen persistente para imágenes y bóveda local (si no se usa bind mount externo)
VOLUME ["/usr/src/app/uploads", "/usr/src/app/storage"]

# Ejecutar con usuario no-root por seguridad
USER node

# Exponer el puerto del backend (5002)
EXPOSE 5002

# Comando de inicio
CMD ["node", "dist/main"]
