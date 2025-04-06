
import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      // Proxy API requests to Motia backend
      '/api': {
        target: 'http://localhost:3000', // Your Motia agent's address
        changeOrigin: true, // Recommended for virtual hosted sites
        secure: false,      // Optional: Set to true if target is https
        // Optional: Rewrite path if needed (e.g., remove /api prefix)
        // rewrite: (path) => path.replace(/^\/api/, ''), 
      },
    },
  },
});
