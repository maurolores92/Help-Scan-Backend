# =========================================================================
# Etapa 1: Compilación (Builder) con Node 22 LTS y PNPM
# =========================================================================
FROM node:22-alpine AS builder

WORKDIR /usr/src/app

# Instalar dependencias del sistema para compilar módulos nativos (bcrypt, etc.)
RUN apk add --no-cache python3 make g++

# Instalar PNPM de forma global
RUN npm install -g pnpm

# Copiar manifiestos de dependencias, configuración y scripts de validación
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml* .npmrc* ./
COPY scripts/ ./scripts/

# Instalar dependencias con PNPM hoisted
RUN pnpm install --no-frozen-lockfile

# Copiar el código fuente completo
COPY . .

# Aumentar memoria para compilación de TypeScript
ENV NODE_OPTIONS="--max-old-space-size=4096"

# Compilar la aplicación NestJS con PNPM
RUN pnpm run build

# =========================================================================
# Etapa 2: Imagen de Producción Ligera y Segura con Node 22 LTS
# =========================================================================
FROM node:22-alpine AS runner

WORKDIR /usr/src/app

ENV NODE_ENV=production
ENV PORT=5002

# Instalar PNPM de forma global
RUN npm install -g pnpm

# Copiar manifiestos y scripts
COPY package.json ./
COPY scripts/ ./scripts/

# Copiar dependencias ya compiladas y verificadas desde la etapa builder
COPY --from=builder /usr/src/app/node_modules ./node_modules

# Copiar la aplicación compilada
COPY --from=builder /usr/src/app/dist ./dist

# Crear directorios de uploads y storage con permisos para el usuario 'node' (UID 1000)
RUN mkdir -p uploads storage && chown -R node:node /usr/src/app/uploads /usr/src/app/storage

# Declarar volumen persistente para imágenes y bóveda local
VOLUME ["/usr/src/app/uploads", "/usr/src/app/storage"]

# Ejecutar con usuario no-root por seguridad
USER node

# Exponer el puerto del backend (5002)
EXPOSE 5002

# Comando de inicio
CMD ["node", "dist/main"]
