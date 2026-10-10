import { describe, expect, test } from 'claude-code/testing'

import { commandsOf, mustAsk, obviouslyReadOnly, prefixesOf, segments } from '../hooks/rules'

describe('segments', () => {
  test('splits on operators and keeps quoted text whole', () => {
    expect(segments('cd a && rm -rf "my dir" | tee log; echo \'a;b\'')).toEqual([['cd', 'a'], ['rm', '-rf', 'my dir'], ['tee', 'log'], ['echo', 'a;b']])
    expect(segments('make 2>&1 &> out & ls')).toEqual([['make', '2>&1', '&>', 'out'], ['ls']])
    expect(segments('ls # rm -rf /\npwd')).toEqual([['ls'], ['pwd']])
  })

  test('reads command substitutions as commands', () => {
    expect(segments('echo $(rm -rf x)')).toContainEqual(['rm', '-rf', 'x'])
    expect(segments('echo "$(rm -rf x)"')).toContainEqual(['rm', '-rf', 'x'])
    expect(segments('echo `rm -rf x`')).toContainEqual(['rm', '-rf', 'x'])
  })
})

describe('commandsOf', () => {
  test('strips assignments and wrappers', () => {
    expect(commandsOf('FOO=1 sudo -u root env A=b nice -n 5 /bin/rm -rf x')).toEqual([['rm', '-rf', 'x']])
    expect(commandsOf('find . -name "*.tmp" | xargs -0 -n 1 rm -r')).toEqual([['find', '.', '-name', '*.tmp'], ['rm', '-r']])
    expect(commandsOf('timeout -s KILL 10 git push -f')).toEqual([['git', 'push', '-f']])
  })

  test('reads the script of sh -c and eval', () => {
    expect(commandsOf('bash -lc "rm -rf ~/x"')).toContainEqual(['rm', '-rf', '~/x'])
    expect(commandsOf("eval 'git push --force'")).toContainEqual(['git', 'push', '--force'])
  })
})

describe('mustAsk', () => {
  test('recursive rm', () => {
    for (const command of ['rm -rf build', 'rm -r build', 'rm -fr build', 'rm -Rf build', 'rm --recursive build', 'sudo rm -rf /', 'cd x && rm -rf y', 'bash -c "rm -rf y"']) {
      expect(mustAsk(command)).toBe('rm -r（遞迴刪除）')
    }
    expect(mustAsk('rm file.txt')).toBeUndefined()
    expect(mustAsk('rm -f file.txt')).toBeUndefined()
    expect(mustAsk('echo "rm -rf /"')).toBeUndefined()
    expect(mustAsk('git commit -m "drop rm -rf from the script"')).toBeUndefined()
  })

  test('deleting a git repository', () => {
    expect(mustAsk('rm -rf .git')).toBe('刪除 git repo（.git）')
    expect(mustAsk('rm -rf ../app/.git/')).toBe('刪除 git repo（.git）')
    expect(mustAsk('gh repo delete me/app --yes')).toBe('刪除 GitHub repo')
    expect(mustAsk('gh api -X DELETE repos/me/app')).toBe('刪除 GitHub repo')
    expect(mustAsk('gh api --method=DELETE /repos/me/app')).toBe('刪除 GitHub repo')
    expect(mustAsk('gh api -X DELETE repos/me/app/issues/comments/1')).toBeUndefined()
    expect(mustAsk('gh repo view me/app')).toBeUndefined()
  })

  test('force pushes and remote deletes', () => {
    for (const command of ['git push --force', 'git push -f origin main', 'git push -uf origin x', 'git push --force-with-lease', 'git push origin +main', 'git -C app push --mirror']) {
      expect(mustAsk(command)).toBe('git push --force（強制推送）')
    }
    expect(mustAsk('git push origin --delete old')).toBe('刪除遠端分支或 tag')
    expect(mustAsk('git push origin :old')).toBe('刪除遠端分支或 tag')
    expect(mustAsk('git push -u origin feature')).toBeUndefined()
    expect(mustAsk('git status')).toBeUndefined()
  })

  test('wiping disks', () => {
    expect(mustAsk('dd if=/dev/zero of=/dev/sda bs=1M')).toBe('抹除磁碟')
    expect(mustAsk('mkfs.ext4 /dev/sdb1')).toBe('抹除磁碟')
    expect(mustAsk('shred -u secret.txt')).toBe('抹除磁碟或檔案')
    expect(mustAsk('dd if=a.img of=b.img')).toBeUndefined()
  })

  test('the prefixes the person added', () => {
    const prefixes = prefixesOf('terraform destroy, kubectl delete,\n  ')
    expect(prefixes).toEqual([['terraform', 'destroy'], ['kubectl', 'delete']])
    expect(mustAsk('terraform destroy -auto-approve', prefixes)).toBe('你設定的「terraform destroy」')
    expect(mustAsk('cd infra && kubectl delete ns prod', prefixes)).toBe('你設定的「kubectl delete」')
    expect(mustAsk('terraform plan', prefixes)).toBeUndefined()
    expect(prefixesOf(undefined)).toEqual([])
  })
})

describe('obviouslyReadOnly', () => {
  test('plain reads', () => {
    for (const command of ['ls -la', 'cat README.md', 'grep -rn "foo bar" src', 'git status', 'git diff HEAD~1', 'find . -name "*.ts"', 'wc -l a b']) {
      expect(obviouslyReadOnly(command)).toBe(true)
    }
  })

  test('anything more goes to Clef', () => {
    for (const command of [
      'ls > out',
      'cat a | sh',
      'echo $HOME',
      'ls; rm x',
      'find . -delete',
      'find . -exec rm {} ;',
      'rg --pre ./x foo',
      'git push',
      'git diff --output=x',
      'npm test',
      'sort -o a a',
    ]) {
      expect(obviouslyReadOnly(command)).toBe(false)
    }
  })
})
