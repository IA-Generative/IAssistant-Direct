module.exports = {
  testEnvironment: 'jsdom',
  setupFiles: ['./tests/setup.js'],
  testMatch: ['**/tests/**/*.test.js'],
  // Ne pas scanner les paquets buildés (build.sh y recopie manifest/package.json,
  // ce qui provoque des collisions de modules haste avec la racine).
  modulePathIgnorePatterns: ['<rootDir>/dist/', '<rootDir>/archive/'],
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/dist/', '<rootDir>/archive/'],
  collectCoverageFrom: [
    'src/dm/bootstrap.js',
    'src/dm/telemetry.js',
    'src/background.js',
    'src/recording.js',
    'src/compat.js'
  ]
};
