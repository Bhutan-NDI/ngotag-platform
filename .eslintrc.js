module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: 'tsconfig.json',
    sourceType: 'module'
  },
  plugins: ['@typescript-eslint/eslint-plugin'],
  extends: ['plugin:@typescript-eslint/recommended', 'plugin:prettier/recommended'],
  root: true,
  env: {
    node: true,
    jest: true
  },
  ignorePatterns: ['.eslintrc.js'],
  rules: {
    'prettier/prettier': 0,
    'no-console': 'error',
    //  "@typescript-eslint/consistent-type-imports": "error",
    '@typescript-eslint/no-unused-vars': [
      'error'
      // {
      //   "argsIgnorePattern": "_"
      // }
    ],
    '@typescript-eslint/array-type': 'error',
    '@typescript-eslint/explicit-function-return-type': 'error',
    '@typescript-eslint/explicit-module-boundary-types': 'warn',
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-use-before-define': 'error',
    complexity: ['error', 50],
    'array-callback-return': 'error',
    curly: 'error',
    'default-case': 'error',
    'default-case-last': 'error',
    'default-param-last': 'error',
    camelcase: [2, { properties: 'always' }],
    'no-invalid-this': 'error',
    'no-return-assign': 'error',
    'no-unused-expressions': ['error', { allowTernary: true }],
    'no-useless-concat': 'error',
    'no-useless-return': 'error',
    'guard-for-in': 'error',
    'no-case-declarations': 'error',
    'no-implicit-coercion': 'error',
    'no-lone-blocks': 'error',
    'no-loop-func': 'error',
    'no-param-reassign': 'error',
    'no-return-await': 'error',
    'no-self-compare': 'error',
    'no-throw-literal': 'error',
    'no-useless-catch': 'error',
    'prefer-promise-reject-errors': 'error',
    'vars-on-top': 'error',
    yoda: ['error', 'always'],
    'arrow-body-style': ['warn', 'as-needed'],
    'no-useless-rename': 'error',
    'prefer-destructuring': [
      'error',
      {
        array: true,
        object: true
      },
      {
        enforceForRenamedProperties: false
      }
    ],
    'prefer-numeric-literals': 'error',
    'prefer-rest-params': 'warn',
    'prefer-spread': 'error',
    'no-mixed-operators': 'error',
    'no-tabs': 'error',
    'no-unneeded-ternary': 'error',
    'no-confusing-arrow': 'off',
    'no-var': 'error',
    'object-shorthand': 'error',
    'prefer-const': 'error',
    'prefer-template': 'error',
    quotes: ['warn', 'single', { allowTemplateLiterals: true }]
  }
};
