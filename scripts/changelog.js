const { spawnSync } = require('child_process');
const { readFileSync, writeFileSync } = require('fs');
//  eslint-disable-next-line import/no-extraneous-dependencies
const { default: getReleasePlan } = require('@changesets/get-release-plan');
//  eslint-disable-next-line import/no-extraneous-dependencies
const { getInfo } = require('@changesets/get-github-info');

// TODO: move this to CI linting
const verbs = new Set(['Adds', 'Changes', 'Fixes', 'Moves', 'Removes', 'Updates', 'Upgrade']);

// TODO: derived?
const publicPackages = [
  '@keystone-6/auth',
  '@keystone-6/cloudinary',
  '@keystone-6/core',
  '@keystone-6/document-renderer',
  '@keystone-6/fields-document',
  '@keystone-6/session-store-redis',
];

const cves = [
  {
    id: 'CVE-2022-36313',
    href: 'https://cve.mitre.org/cgi-bin/cvename.cgi?name=CVE-2022-36313',
    upstream: true,
    description: `
      An upstream transitive dependency \`file-type\` is vulnerable to a ReDoS.
      We have upgraded to a version of \`file-type\` that is fixed.
    `,
  },
  {
    id: 'CVE-2023-23936',
    href: 'https://github.com/advisories/GHSA-5r9g-qh6m-jxff',
    upstream: true,
    description: `
      An upstream transitive dependency \`undici\` is vulnerable to a HTTP header CRLF injection vulnerability.
      We have upgraded to a version of \`@prisma/core\` that uses a fixed \`undici\`.
    `,
  },
  {
    id: 'CVE-2023-24807',
    href: 'https://github.com/advisories/GHSA-r6ch-mqf9-qc9w',
    upstream: true,
    description: `
      An upstream transitive dependency \`undici\` is vulnerable to a ReDoS.
      We have upgraded to a version of \`@prisma/core\` that uses a fixed \`undici\`.
    `,
  },
];

function gitCommitsSince(tag) {
  const { stdout } = spawnSync('git', ['rev-list', `^${tag}`, 'HEAD']);
  return stdout
    .toString('utf-8')
    .split('\n')
    .filter(x => x);
}

function firstGitCommitOf(path) {
  const { stdout } = spawnSync('git', [
    'rev-list',
    '--date-order',
    '--reverse',
    'HEAD',
    '--',
    path,
  ]);
  return stdout
    .toString('utf-8')
    .split(' ', 1)
    .pop()
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 40);
}

function gitCommitDescription(commit) {
  const { stdout } = spawnSync('git', ['log', '--oneline', commit]);
  return stdout.toString('utf-8').split('\n', 1).pop().slice(10);
}

async function fetchData(tag) {
  const { changesets, releases } = await getReleasePlan('.');

  // find the commits since the tag
  const revs = gitCommitsSince(tag);
  console.error(`${revs.length} commits since ${tag}`);
  if (revs.length === 0) throw new Error('No commits');
  if (revs.length > 200) throw new Error('Too many commits');

  // tag changesets with their commits
  for (const changeset of changesets) {
    const commit = firstGitCommitOf(`.changeset/${changeset.id}.md`);

    if (!revs.includes(commit)) throw new Error(`Unexpected commit ${changeset.commit}`);
    console.error(`commit ${commit} found for changeset ${changeset.id}`);
    changeset.commit = commit;
  }

  // list all the contributors
  const previousContributors = JSON.parse(
    readFileSync('.changeset/contributors.json').toString('utf-8')
  );

  const githubCommits = {};
  for (const commit of revs) {
    let { user, pull } = await getInfo({ repo: 'keystonejs/keystone', commit });
    pull = pull || gitCommitDescription(commit).match(/#([0-9]+)/)?.[1];

    console.error(`commit ${commit}, user ${user}, pull #${pull}`);
    const first = !previousContributors.includes(user);
    githubCommits[commit] = { commit, user, pull, first };
  }

  // augment changesets with git information
  const changes = [];
  for (const changeset of changesets) {
    const { releases, summary, commit } = changeset;

    // TODO: move this to CI linting
    const describedType = summary.split(' ')[0];
    if (!verbs.has(describedType)) {
      console.warn(`  Verb '${describedType}' is non-standard for a changeset`);
    }

    // poor semver precedence
    let type;
    for (const release of releases) {
      if (['minor', 'patch', undefined].includes(type) && release.type === 'major') type = 'major';
      if (['patch', undefined].includes(type) && release.type === 'minor') type = 'minor';
      if ([undefined].includes(type) && release.type === 'patch') type = 'patch';
    }
    if (!type) throw new Error('Unknown type');

    // only public packages, then strip the namespace
    const packages = releases
      .filter(x => publicPackages.includes(x.name))
      .map(x => x.name.replace('@keystone-6/', ''))
      .sort();

    const githubCommit = githubCommits[commit];
    changes.push({
      ...githubCommit,
      summary,
      type,
      packages,
    });
  }

  // if no changeset was associated with a commit, we still want to acknowledge the work
  for (const [commit, githubCommit] of Object.entries(githubCommits)) {
    if (changes.find(x => x.commit === commit)) continue;
    changes.push(githubCommit);
  }

  // find the set of our contributors
  const contributors = [...new Set([...previousContributors, ...changes.map(x => x.user)])];

  // only public packages
  const packages = releases
    .filter(x => publicPackages.includes(x.name))
    .filter(x => x.type !== 'none')
    .map(x => `${x.name}@${x.newVersion}`)
    .sort();

  return { packages, changes, contributors };
}

function formatPackagesChanged(packages) {
  return `The following packages have been updated
%%%
${packages.join('\n')}
%%%`.replace(/%/g, '`');
}

function formatChange({ packages, summary, pull, user }) {
  return `- \`[${packages.join(', ')}]\` ${summary} (#${pull}) @${user}`;
}

function formatCVE({ id, href, upstream, description }) {
  description = description.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  return `- [\`${id}\`](${href}) - ${description}`;
}

function formatLink(pull) {
  return `[#${pull}](https://github.com/keystonejs/keystone/pull/${pull})`;
}

function sortByCommit(a, b) {
  return a.commit.localeCompare(b.commit);
}

function groupPullsByUser(list) {
  const result = {};
  for (const item of list) {
    if (!item.pull) continue;
    result[item.user] ||= [];
    result[item.user].push(item.pull);
  }
  return Object.entries(result)
    .map(([user, pulls]) => ({ user, pulls }))
    .sort((a, b) => a.user.localeCompare(b.user));
}

async function generateGitHubReleaseText(previousTag) {
  if (!previousTag) throw new Error('Missing tag');

  const date = new Date().toISOString().slice(0, 10).replace(/\-/g, '_');
  const { packages, changes, contributors } = await fetchData(previousTag);
  //    writeFileSync(`./CHANGELOG-${date}.json`, JSON.stringify({ packages, changes, contributors }, null, 2))
  //    return process.exit(0)
  //    const { packages, changes, contributors } = JSON.parse(readFileSync(`./CHANGELOG-${date}.json`))

  const output = [];
  output.push(formatPackagesChanged(packages));
  output.push('');

  const breaking = changes.filter(x => x.type === 'major').sort(sortByCommit);
  const features = changes.filter(x => x.type === 'minor').sort(sortByCommit);
  const fixes = changes.filter(x => x.type === 'patch').sort(sortByCommit);

  if (breaking.length) {
    output.push(...[`#### Breaking Changes`, ...breaking.map(formatChange), ``]);
  }

  if (features.length) {
    output.push(...[`#### New Features`, ...features.map(formatChange), ``]);
  }

  if (fixes.length) {
    output.push(...[`#### Bug Fixes`, ...fixes.map(formatChange), ``]);
  }

  if (cves.length) {
    output.push(
      ...[
        `#### :rotating_light: Security Updates`,
        `We have identified and fixed ${cves.length}${
          cves.some(x => x.upstream) ? ' upstream' : ''
        } security vulnerabilities`,
        ...cves.map(formatCVE),
        ``,
      ]
    );
  }

  const first = changes.filter(x => x.first);
  const unattributed = changes.filter(x => !x.type && !x.first);

  if (first.length) {
    const listf = groupPullsByUser(first);

    output.push(`#### :seedling: New Contributors`);
    output.push(
      `Thanks to the following developers for making their first contributions to the project!`
    );
    output.push(
      ...listf.map(({ user, pulls }) => `- @${user} (${pulls.map(formatLink).join(',')})`)
    );
    output.push(``);
  }

  if (unattributed.length) {
    const listu = groupPullsByUser(unattributed);

    output.push(`#### :blue_heart: Acknowledgements `);
    output.push(
      `Lastly, thanks to ${listu
        .map(({ user, pulls }) => `@${user} (${pulls.map(formatLink).join(',')})`)
        .join(', ')} for changes not shown above, but none-the-less appreciated.`
    );
    output.push(``);
  }

  writeFileSync('./.changeset/contributors.json', JSON.stringify(contributors.sort(), null, 2));
  writeFileSync(`./CHANGELOG-${date}.md`, output.join('\n'));
  console.error('files written');
}

generateGitHubReleaseText(process.argv[2]);
