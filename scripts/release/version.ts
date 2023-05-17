/* eslint-disable @typescript-eslint/naming-convention */
/* eslint-disable no-underscore-dangle */
/* eslint-disable no-console */
import { ensureDir, readFile, readJson, writeFile, writeJson } from 'fs-extra';
import chalk from 'chalk';
import path from 'path';
import program from 'commander';
import semver from 'semver';
import { z } from 'zod';
import dedent from 'ts-dedent';
import { execaCommand } from '../utils/exec';
import { listOfPackages } from '../utils/list-packages';
import packageVersionMap from '../../code/lib/cli/src/versions';

program
  .name('version')
  .description('version all packages')
  .option('flags')
  .requiredOption(
    '-R, --release-type <major|minor|patch|prerelease>',
    'Which release type to use to bump the version'
  )
  .option('-P, --pre-id <id>', 'Which prerelease identifer to change to, eg. "alpha", "beta", "rc"')
  .option('-V, --verbose', 'Enable verbose logging', false);

const optionsSchema = z
  .object({
    releaseType: z.enum([
      'major',
      'minor',
      'patch',
      'prerelease',
      'premajor',
      'preminor',
      'prepatch',
    ]),
    preId: z.string().optional(),
    verbose: z.boolean(),
  })
  .refine((schema) => (schema.preId ? schema.releaseType.startsWith('pre') : true), {
    message:
      'Using prerelease identifier requires one of release types: premajor, preminor, prepatch, prerelease',
  });

type Options = {
  releaseType: semver.ReleaseType;
  preId?: string;
  verbose: boolean;
};

const CODE_DIR_PATH = path.join(__dirname, '..', '..', 'code');
const CODE_PACKAGE_JSON_PATH = path.join(CODE_DIR_PATH, 'package.json');

const validateOptions = (options: { [key: string]: any }): options is Options => {
  optionsSchema.parse(options);
  return true;
};

const getCurrentVersion = async () => {
  console.log(`📐 Reading current version of Storybook...`);
  const { version } = await readJson(CODE_PACKAGE_JSON_PATH);
  return version;
};

const bumpCodeVersion = async (nextVersion: string) => {
  console.log(`🤜 Bumping version of ${chalk.cyan('code')}'s package.json...`);

  const codePkgJson = await readJson(CODE_PACKAGE_JSON_PATH);

  codePkgJson.version = nextVersion;
  await writeJson(CODE_PACKAGE_JSON_PATH, codePkgJson, { spaces: 2 });

  console.log(`✅ Bumped version of ${chalk.cyan('code')}'s package.json`);
};

const bumpAllPackageVersions = async (nextVersion: string, verbose?: boolean) => {
  console.log(`🤜 Bumping version of ${chalk.cyan('all packages')}...`);

  /**
   * This uses the release workflow outlined by Yarn documentation here:
   * https://yarnpkg.com/features/release-workflow
   *
   * However we build the release YAML file manually instead of using the `yarn version --deferred` command
   * This is super hacky, but it's also way faster than invoking `yarn version` for each package, which is 1s each
   *
   * A simpler alternative is to use Lerna with:
   * await execaCommand(`yarn lerna version ${nextVersion} --no-git-tag-version --exact`, {
   *    cwd: CODE_DIR_PATH,
   *    stdio: verbose ? 'inherit' : undefined,
   * });
   * However that doesn't update peer deps. Trade offs
   */
  const yarnVersionsPath = path.join(__dirname, '..', '..', 'code', '.yarn', 'versions');
  let yarnDefferedVersionFileContents = dedent`# this file is auto-generated by scripts/release/version.ts
  releases:
  
  `;
  Object.keys(packageVersionMap).forEach((packageName) => {
    yarnDefferedVersionFileContents += `  '${packageName}': ${nextVersion}\n`;
  });
  await ensureDir(yarnVersionsPath);
  await writeFile(
    path.join(yarnVersionsPath, 'generated-by-versions-script.yml'),
    yarnDefferedVersionFileContents
  );

  await execaCommand('yarn version apply --all', {
    cwd: CODE_DIR_PATH,
    stdio: verbose ? 'inherit' : undefined,
  });

  console.log(`✅ Bumped version of ${chalk.cyan('all packages')}`);
};

const bumpVersionSources = async (currentVersion: string, nextVersion: string) => {
  const filesToUpdate = [
    path.join(CODE_DIR_PATH, 'lib', 'manager-api', 'src', 'version.ts'),
    path.join(CODE_DIR_PATH, 'lib', 'cli', 'src', 'versions.ts'),
  ];
  console.log(`🤜 Bumping versions in...:\n  ${chalk.cyan(filesToUpdate.join('\n  '))}`);

  await Promise.all(
    filesToUpdate.map(async (filename) => {
      const currentContent = await readFile(filename, { encoding: 'utf-8' });
      const nextContent = currentContent.replaceAll(currentVersion, nextVersion);
      return writeFile(filename, nextContent);
    })
  );

  console.log(`✅ Bumped versions in:\n  ${chalk.cyan(filesToUpdate.join('\n  '))}`);
};

export const run = async (options: unknown) => {
  if (!validateOptions(options)) {
    return;
  }
  const { releaseType, preId, verbose } = options;

  console.log(`📈 Release type selected: ${chalk.green(releaseType)}`);
  if (preId) {
    console.log(`🆔 Version prerelease identifier selected: ${chalk.yellow(preId)}`);
  }

  console.log(`🚛 Finding Storybook packages...`);

  const [packages, currentVersion] = await Promise.all([listOfPackages(), getCurrentVersion()]);

  console.log(
    `📦 found ${packages.length} storybook packages at version ${chalk.red(currentVersion)}`
  );
  if (verbose) {
    const formattedPackages = packages.map(
      (pkg) =>
        `${chalk.green(pkg.name.padEnd(60))}${chalk.red(pkg.version)}: ${chalk.cyan(pkg.location)}`
    );
    console.log(`📦 Packages:
    ${formattedPackages.join('\n    ')}`);
  }

  const nextVersion = semver.inc(currentVersion, releaseType, preId);

  console.log(
    `⏭ Bumping version ${chalk.blue(currentVersion)} with release type ${chalk.green(releaseType)}${
      preId ? ` and ${chalk.yellow(preId)}` : ''
    } results in version: ${chalk.bgGreenBright.bold(nextVersion)}`
  );

  console.log(`⏭ Bumping all packages to ${chalk.blue(nextVersion)}...`);

  await bumpCodeVersion(nextVersion);
  await bumpAllPackageVersions(nextVersion, verbose);
  await bumpVersionSources(currentVersion, nextVersion);
};

if (require.main === module) {
  const options = program.parse().opts();
  run(options).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
