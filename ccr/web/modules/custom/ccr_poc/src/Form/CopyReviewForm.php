<?php

namespace Drupal\ccr_poc\Form;

use Drupal\ccr_poc\CopyStore;
use Drupal\ccr_poc\Entity\DeckGeneration;
use Drupal\ccr_poc\RendererClient;
use Drupal\ccr_poc\SitePublisher;
use Drupal\Component\Utility\Html;
use Drupal\Core\Form\FormBase;
use Drupal\Core\Form\FormStateInterface;
use Drupal\node\NodeInterface;
use Symfony\Component\DependencyInjection\ContainerInterface;
use Symfony\Component\HttpFoundation\Response;

/**
 * Write one channel's copy from a record's source material, and approve it.
 *
 * plan.md §8 A2. The record holds what is true; this page is where a channel's
 * words for it are drafted — by the writing assistant or by hand — checked the
 * way that channel will check them, and approved by a person. Nothing reaches a
 * slide or the website from here without that approval, and nothing on this
 * page writes to the record.
 *
 * The page knows no channel by heart. Its fields, their limits and what each is
 * for come from the channel's own contract: a written slide template's card,
 * asked of the renderer, or the website's contract, asked of the website. The
 * measuring is the renderer's (`/copy/check`), so a field that does not fit is
 * reported in the same words whether a model or a marketer wrote it.
 */
class CopyReviewForm extends FormBase {

  public function __construct(
    protected RendererClient $renderer,
    protected SitePublisher $site,
    protected CopyStore $store,
  ) {}

  public static function create(ContainerInterface $container): static {
    return new static(
      $container->get('ccr_poc.renderer'),
      $container->get('ccr_poc.site_publisher'),
      $container->get('ccr_poc.copy_store'),
    );
  }

  public function getFormId(): string {
    return 'ccr_poc_copy_review';
  }

  /**
   * The channel being written for, as whoever owns it describes it.
   *
   * @return array{id: string, name: string, kind: string, contract: array, request: array, warnings: array}|null
   */
  private function target(NodeInterface $node, string $channel): ?array {
    if ($channel === CopyStore::WEBSITE) {
      $contract = $this->site->contract($node->bundle());
      return $contract ? [
        'id' => $channel,
        'name' => $contract['name'],
        'kind' => 'website',
        'contract' => $contract['contract'],
        'request' => ['contract' => $contract],
        'warnings' => [],
      ] : NULL;
    }
    $template = $this->renderer->writtenTemplates($node->bundle())[$channel] ?? NULL;
    return $template ? [
      'id' => $channel,
      'name' => $template['name'],
      'kind' => 'deck',
      'contract' => $template['contract'],
      'request' => ['template' => $channel],
      'warnings' => array_filter([$template['placeholderArt'] ?? NULL]),
    ] : NULL;
  }

  public function buildForm(array $form, FormStateInterface $form_state, ?NodeInterface $node = NULL, string $channel = ''): array {
    $form_state->set('node', $node);
    $form_state->set('channel', $channel);
    $form['#attached']['library'][] = 'ccr_poc/copy';

    $target = $this->target($node, $channel);
    if (!$target) {
      $form['missing'] = [
        '#markup' => '<div class="ccr-alert ccr-alert--blocked">' . $this->t(
          '<strong>Nothing to write for "@channel".</strong> Either that channel is not answering, or it has nothing written for a @type. Check <code>./demo.sh status</code>.',
          ['@channel' => $channel, '@type' => $node->bundle()]
        ) . '</div>',
      ];
      return $form;
    }
    $form_state->set('target', $target);
    $form['#title'] = $this->t('Write: @channel', ['@channel' => $target['name']]);

    $entry = $this->store->get($node, $channel);
    $form['status'] = ['#markup' => $this->statusLine($node, $entry, $target)];

    foreach (array_unique(array_merge($target['warnings'], $entry['warnings'] ?? [])) as $warning) {
      $form['warning'][] = ['#markup' => '<div class="ccr-alert ccr-alert--fit"><strong>' . $this->t('Before this goes to a client:') . '</strong> ' . Html::escape($warning) . '</div>'];
    }

    $ai = $this->renderer->assistantAvailable();
    $form['assist'] = ['#type' => 'container', '#attributes' => ['class' => ['ccr-copy__assist']]];
    if ($ai) {
      $form['assist']['draft'] = [
        '#type' => 'submit',
        '#name' => 'draft',
        '#value' => $entry ? $this->t('Redraft everything from the source') : $this->t('Draft from the source'),
        '#limit_validation_errors' => [],
        '#submit' => ['::draft'],
      ];
      $form['assist']['note'] = [
        '#markup' => '<p class="ccr-copy__hint">' . $this->t('The writing assistant drafts every field from the source material. Each field is measured and checked against the source before you see it; a field it could not get right is left empty, with the reason.') . '</p>',
      ];
    }
    else {
      $form['assist']['note'] = [
        '#markup' => '<p class="ccr-copy__hint">' . $this->t('The writing assistant is not set up on this machine, so write the copy yourself — it is checked the same way. To switch the assistant on, put <code>ANTHROPIC_API_KEY</code> in <code>renderer/.env</code> and run <code>./demo.sh start</code>.') . '</p>',
      ];
    }

    $form['copy'] = ['#type' => 'container', '#tree' => TRUE, '#attributes' => ['class' => ['ccr-copy']]];
    $copy = $entry['copy'] ?? [];
    $results = $entry['fields'] ?? [];

    foreach ($target['contract'] as $slot) {
      $key = $slot['source'];
      if (($slot['kind'] ?? 'text') !== 'repeat') {
        $form['copy'][$key] = $this->element($slot, $copy[$key] ?? '', $results[$key] ?? NULL);
        continue;
      }
      $range = $slot['min'] === $slot['max'] ? $slot['max'] : $slot['min'] . '–' . $slot['max'];
      $form['copy'][$key] = [
        '#type' => 'fieldset',
        '#title' => $this->t('@label (@range)', ['@label' => $slot['label'], '@range' => $range]),
        '#description' => Html::escape($slot['brief'] ?? '') . ' ' . $this->t('Leave a row empty to leave it out.'),
        '#field_suffix' => $this->verdict($results[$key] ?? NULL),
      ];
      $items = array_values($copy[$key] ?? []);
      for ($i = 0; $i < $slot['max']; $i++) {
        $form['copy'][$key][$i] = ['#type' => 'container', '#attributes' => ['class' => ['ccr-copy__row']]];
        foreach ($slot['slots'] as $child) {
          $element = $this->element($child, $items[$i][$child['source']] ?? '', NULL);
          $element['#title'] = $this->t('@n. @label', ['@n' => $i + 1, '@label' => ucfirst($child['label'])]);
          $form['copy'][$key][$i][$child['source']] = $element;
        }
      }
    }

    $form['actions'] = ['#type' => 'actions'];
    $form['actions']['save'] = [
      '#type' => 'submit',
      '#name' => 'save',
      '#value' => $this->t('Save and check'),
      '#submit' => ['::save'],
    ];
    $form['actions']['approve'] = [
      '#type' => 'submit',
      '#name' => 'approve',
      '#value' => $target['kind'] === 'deck' ? $this->t('Approve and generate the slide') : $this->t('Approve and publish to the website'),
      '#button_type' => 'primary',
      '#submit' => ['::approve'],
    ];
    return $form;
  }

  /** One field, as the form element that suits its shape. */
  private function element(array $slot, $value, ?array $result): array {
    $limit = $this->t('Limit: @n characters@lines.', [
      '@n' => $slot['maxChars'],
      '@lines' => isset($slot['maxLines']) ? $this->t(', @l line@s in the box', ['@l' => $slot['maxLines'], '@s' => $slot['maxLines'] == 1 ? '' : 's']) : '',
    ]);
    $element = [
      '#title' => $slot['label'],
      // Escaped: a brief may quote the markup it asks for ("<strong>").
      '#description' => trim(Html::escape($slot['brief'] ?? '') . ' ' . $limit),
      '#default_value' => $value,
      '#field_suffix' => $this->verdict($result),
    ];
    if (!empty($slot['emphasis']) || ($slot['paragraphs'] ?? 1) > 1) {
      return $element + [
        '#type' => 'text_format',
        '#format' => 'ccr_inline',
        '#allowed_formats' => ['ccr_inline'],
      ];
    }
    return $element + ($slot['maxChars'] > 120
      ? ['#type' => 'textarea', '#rows' => 3]
      : ['#type' => 'textfield', '#size' => 90, '#maxlength' => 1024]);
  }

  /** What the last check said about a field, in the marketer's words. */
  private function verdict(?array $result): string {
    if (!$result) {
      return '';
    }
    $out = '';
    foreach ($result['problems'] ?? [] as $problem) {
      $out .= '<span class="ccr-copy__problem">' . Html::escape($problem) . '</span>';
    }
    foreach ($result['warnings'] ?? [] as $warning) {
      $out .= '<span class="ccr-copy__warning">' . Html::escape($warning) . '</span>';
    }
    if ($out === '' && ($result['status'] ?? 'ok') === 'ok') {
      $out = '<span class="ccr-copy__ok">' . $this->t('Fits, and every number is in the source.') . '</span>';
    }
    return '<div class="ccr-copy__verdict">' . $out . '</div>';
  }

  private function statusLine(NodeInterface $node, ?array $entry, array $target): string {
    $date = fn($t) => \Drupal::service('date.formatter')->format((int) $t, 'short');
    $state = $this->store->state($node, $target['id']);
    $line = match ($state) {
      'none' => $this->t('Nothing has been written for this channel yet.'),
      'draft' => $this->t('A draft, not yet approved — last changed @when by @who.', ['@when' => $date($entry['drafted_at']), '@who' => $entry['drafted_by']]),
      'approved' => $this->t('Approved @when by @who.', ['@when' => $date($entry['approved_at']), '@who' => $entry['approved_by']]),
      'out-of-date' => $this->t('<strong>Out of date.</strong> The source material changed after this copy was written. Redraft it, or check and approve it again.'),
    };
    $published = !empty($entry['url'])
      ? ' ' . $this->t('On the website since @when: <a href=":url" target="_blank">view the page</a>.', ['@when' => $date($entry['published_at']), ':url' => $entry['url']])
      : '';
    $class = $state === 'out-of-date' ? 'ccr-alert ccr-alert--stale' : 'ccr-copy__status';
    return '<div class="' . $class . '"><strong>' . Html::escape($node->label()) . '.</strong> ' . $line . $published . ' <a href="' . $node->toUrl('edit-form')->toString() . '">' . $this->t('Edit the source material') . '</a></div>';
  }

  /**
   * The form's copy, in the shape the channel renders: text as stored, rows
   * with keys and an order, empty rows left out.
   */
  private function collect(FormStateInterface $form_state): array {
    $target = $form_state->get('target');
    $values = $form_state->getValue('copy') ?? [];
    $copy = [];
    foreach ($target['contract'] as $slot) {
      $key = $slot['source'];
      if (($slot['kind'] ?? 'text') !== 'repeat') {
        $copy[$key] = $this->text($slot, $values[$key] ?? '');
        continue;
      }
      $items = [];
      foreach ($values[$key] ?? [] as $row) {
        $item = [];
        foreach ($slot['slots'] as $child) {
          $item[$child['source']] = $this->text($child, $row[$child['source']] ?? '');
        }
        if (implode('', $item) === '') {
          continue;
        }
        $n = count($items) + 1;
        $items[] = ['key' => $key . '-' . $n, 'weight' => $n] + $item;
      }
      $copy[$key] = $items;
    }
    return $copy;
  }

  /**
   * One value as the channel stores it. The editor always wraps text in <p>;
   * a one-paragraph field is unwrapped, and a field that carries no emphasis
   * loses any bold that was typed into it rather than having it reach a page
   * that has no treatment for it.
   */
  private function text(array $slot, $raw): string {
    $value = trim(is_array($raw) ? ($raw['value'] ?? '') : (string) $raw);
    $paragraphs = (int) ($slot['paragraphs'] ?? 1);
    if ($paragraphs === 1) {
      $value = trim(preg_replace('#\s*</p>\s*<p[^>]*>\s*#', ' ', $value));
      $value = preg_replace('#^<p[^>]*>|</p>$#', '', $value);
    }
    if (empty($slot['emphasis'])) {
      $value = strip_tags($value, $paragraphs > 1 ? '<p><br>' : '');
      if ($paragraphs === 1) {
        $value = Html::decodeEntities($value);
      }
    }
    return trim($value);
  }

  public function submitForm(array &$form, FormStateInterface $form_state): void {
    // Every button has its own handler.
  }

  public function draft(array &$form, FormStateInterface $form_state): void {
    [$node, $target] = [$form_state->get('node'), $form_state->get('target')];
    $result = $this->renderer->draft($node, $target['request']);

    if (!empty($result['reason']) && empty($result['copy'])) {
      $this->messenger()->addError($result['reason']);
    }
    else {
      $this->store->saveDraft($node, $target['id'], $result['copy'], $result['fields'], $result['warnings'], $this->currentUser(), TRUE);
      $failed = array_keys(array_filter($result['fields'], fn($f) => ($f['status'] ?? '') === 'failed'));
      if ($failed) {
        $this->messenger()->addWarning($this->t('Drafted. @n field(s) could not be written to pass their checks and are left empty, with the reason: @list. Write those yourself, or add what they need to the source material.', [
          '@n' => count($failed),
          '@list' => implode(', ', $failed),
        ]));
      }
      else {
        $this->messenger()->addStatus($this->t('Drafted. Every field fits and every number in it is in the source. Read it before you approve it — the checks cannot tell you whether it says the right thing.'));
      }
    }
    $this->back($form_state);
  }

  public function save(array &$form, FormStateInterface $form_state): void {
    [$node, $target] = [$form_state->get('node'), $form_state->get('target')];
    $copy = $this->collect($form_state);
    $check = $this->renderer->checkCopy($node, $target['request'], $copy);
    if (!empty($check['reason'])) {
      $this->messenger()->addError($check['reason']);
    }
    $this->store->saveDraft($node, $target['id'], $copy, $this->asResults($check['fields']), $check['warnings'], $this->currentUser(), FALSE);
    $check['ok']
      ? $this->messenger()->addStatus($this->t('Saved. Every field passes; it is ready to approve.'))
      : $this->messenger()->addWarning($this->t('Saved as a draft. Some fields do not pass yet — see below.'));
    $this->back($form_state);
  }

  public function approve(array &$form, FormStateInterface $form_state): void {
    [$node, $target] = [$form_state->get('node'), $form_state->get('target')];
    $copy = $this->collect($form_state);
    $check = $this->renderer->checkCopy($node, $target['request'], $copy);

    if (!empty($check['reason']) || !$check['ok']) {
      $this->store->saveDraft($node, $target['id'], $copy, $this->asResults($check['fields']), $check['warnings'], $this->currentUser(), FALSE);
      $this->messenger()->addError($check['reason'] ?? $this->t('Not approved: some fields do not pass. They are marked below.'));
      $this->back($form_state);
      return;
    }

    $this->store->approve($node, $target['id'], $copy, $this->asResults($check['fields']), $check['warnings'], $this->currentUser());

    if ($target['kind'] === 'website') {
      try {
        $published = $this->site->publishCopy($node, $copy);
        $this->store->markPublished($node, $published['url']);
        $this->messenger()->addStatus($this->t('Approved and published. The page was @action. <a href=":url" target="_blank">View it</a>.', [
          '@action' => $published['action'],
          ':url' => $published['url'],
        ]));
      }
      catch (\RuntimeException $e) {
        $this->messenger()->addError($this->t('Approved, but not published: @reason', ['@reason' => $e->getMessage()]));
      }
      $form_state->setRedirect('entity.node.canonical', ['node' => $node->id()]);
      return;
    }

    // A slide: the deck is this one written slide, kept in the deck log like
    // any other so it goes stale — and is flagged — when the source moves.
    $owner = $this->currentUser()->getAccountName() ?: 'anonymous';
    $entries = [$this->store->deckEntry($node, $target['id'], [])];
    try {
      $deck = $this->renderer->renderDeck($entries, $node->label());
    }
    catch (\RuntimeException $e) {
      $this->messenger()->addError($this->t('Approved, but the slide could not be generated. @reason', ['@reason' => $e->getMessage()]));
      $this->back($form_state);
      return;
    }
    DeckGeneration::saveDeck('deck-' . $node->id() . '-' . preg_replace('/[^a-z0-9]+/', '-', strtolower($owner)), $node->label(), $owner, $entries);

    $form_state->setResponse(new Response($deck['body'], 200, [
      'Content-Type' => 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'Content-Disposition' => 'attachment; filename="' . $deck['filename'] . '"',
      'Content-Length' => strlen($deck['body']),
      'Cache-Control' => 'no-store',
    ]));
  }

  /** A check's per-field answer in the shape a draft's is stored in. */
  private function asResults(array $fields): array {
    return array_map(fn($f) => $f + ['status' => empty($f['problems']) ? 'ok' : 'failed'], $fields);
  }

  /** Back to this page, showing what is now stored rather than what was typed. */
  private function back(FormStateInterface $form_state): void {
    $form_state->setRedirect('ccr_poc.write', [
      'node' => $form_state->get('node')->id(),
      'channel' => $form_state->get('channel'),
    ]);
  }

}
