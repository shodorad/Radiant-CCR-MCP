<?php

namespace Drupal\ccr_poc\Form;

use Drupal\ccr_poc\Entity\DeckGeneration;
use Drupal\ccr_poc\RendererClient;
use Drupal\Core\Form\FormBase;
use Drupal\Core\Form\FormStateInterface;
use Drupal\node\NodeInterface;
use Symfony\Component\DependencyInjection\ContainerInterface;
use Symfony\Component\HttpFoundation\Response;

/**
 * Build a deck from this record: which templates, in what order, showing which
 * items.
 *
 * This is where the sharpest thing the POC was missing became a thing a person
 * can do. The repository holds six capability pillars because the business has
 * six. No slide template holds six. Until this form existed the only way to
 * make a deck was to delete a pillar — the artwork editing the business, which
 * is the collateral problem the CCR exists to end, reproduced inside the fix.
 *
 * So the choice is made here and stored on the deck. Nothing on this page
 * writes to the node. A marketer can build two decks from one record on the
 * same afternoon that show different fives, and the record does not move.
 *
 * The template list, the counts and the refusals all come from the renderer's
 * /match — the repository does not know what a template is or why one refuses.
 * It shows the answer in the marketer's words and lets them choose.
 */
class DeckBuilderForm extends FormBase {

  public function __construct(protected RendererClient $renderer) {}

  public static function create(ContainerInterface $container): static {
    return new static($container->get('ccr_poc.renderer'));
  }

  public function getFormId(): string {
    return 'ccr_poc_deck_builder';
  }

  /** One deck per person per record, so "my deck" is a thing you come back to. */
  private function deckId(NodeInterface $node): string {
    $owner = $this->currentUser()->getAccountName() ?: 'anonymous';
    return 'deck-' . $node->id() . '-' . preg_replace('/[^a-z0-9]+/', '-', strtolower($owner));
  }

  public function buildForm(array $form, FormStateInterface $form_state, ?NodeInterface $node = NULL): array {
    $form_state->set('node', $node);

    $templates = $this->renderer->match($node);
    if (!$templates) {
      $form['down'] = [
        '#markup' => '<div class="ccr-alert ccr-alert--blocked"><strong>The deck renderer is not answering,</strong> '
          . 'so there is nothing to choose from. Start it with <code>./demo.sh start</code>.</div>',
      ];
      return $form;
    }

    $usable = array_filter($templates, fn($t) => $t['status'] !== 'refused');
    $refused = array_filter($templates, fn($t) => $t['status'] === 'refused');

    $saved = DeckGeneration::loadDeck($this->deckId($node));
    $pillars = $this->pillars($node);

    $form['#attached']['library'][] = 'ccr_poc/dashboard';
    $form['intro'] = [
      '#markup' => '<p class="ccr-builder__intro">This record has <strong>' . count($pillars) . ' capability pillars</strong>. '
        . 'Each slide below shows as many as its template holds — you choose which. '
        . 'Nothing here changes the record.</p>',
    ];

    if ($refused) {
      $items = [];
      foreach ($refused as $template) {
        $why = array_map(fn($r) => $r['message'], $template['refusals']);
        $items[] = '<strong>' . htmlspecialchars($template['name']) . '</strong> — ' . htmlspecialchars(implode(' ', $why));
      }
      $form['refused'] = [
        '#markup' => '<div class="ccr-alert ccr-alert--fit"><strong>Templates this record cannot use:</strong><ul><li>'
          . implode('</li><li>', $items) . '</li></ul></div>',
      ];
    }

    $options = [];
    foreach ($usable as $template) {
      $options[$template['id']] = $template['name'];
    }

    // A fixed number of slots rather than an add/remove dance: the POC's decks
    // are short, and a form that can be reasoned about in one glance is worth
    // more here than one that scales to fifty slides.
    $slots = max(3, count($saved) + 1);
    $form['slides'] = ['#type' => 'container', '#tree' => TRUE];

    for ($i = 0; $i < $slots; $i++) {
      $row = $saved[$i] ?? NULL;
      $chosenTemplate = $row ? $row->get('template')->value : ($i === 0 ? array_key_first($options) : '');
      $chosenItems = $row ? ($row->getSelection()['items'] ?? []) : [];

      $form['slides'][$i] = [
        '#type' => 'details',
        '#title' => $this->t('Slide @n', ['@n' => $i + 1]),
        '#open' => $i < max(1, count($saved)),
      ];
      $form['slides'][$i]['template'] = [
        '#type' => 'select',
        '#title' => $this->t('Template'),
        '#options' => ['' => $this->t('— not used —')] + $options,
        '#default_value' => $chosenTemplate,
      ];

      foreach ($usable as $template) {
        $holds = $template['holds']['items'] ?? NULL;
        if (!$holds) {
          continue;
        }
        $range = $holds['min'] === $holds['max'] ? $holds['max'] : $holds['min'] . '–' . $holds['max'];
        $form['slides'][$i]['items_' . $this->key($template['id'])] = [
          '#type' => 'checkboxes',
          '#title' => $this->t('Which pillars (@name holds @range)', [
            '@name' => $template['name'],
            '@range' => $range,
          ]),
          '#description' => $holds['refusal'] ?: '',
          '#options' => $pillars,
          '#default_value' => $chosenTemplate === $template['id'] ? $chosenItems : [],
          '#states' => [
            'visible' => [
              ':input[name="slides[' . $i . '][template]"]' => ['value' => $template['id']],
            ],
          ],
        ];
      }
    }

    $form['actions'] = ['#type' => 'actions'];
    $form['actions']['generate'] = [
      '#type' => 'submit',
      '#value' => $this->t('Generate deck'),
      '#button_type' => 'primary',
    ];

    return $form;
  }

  /** A checkbox key Drupal will not mangle: uuids contain dashes, which is fine. */
  private function key(string $id): string {
    return preg_replace('/[^a-z0-9_]+/', '_', strtolower($id));
  }

  /** The record's pillars as checkbox options, in the order the editor set. */
  private function pillars(NodeInterface $node): array {
    $options = [];
    foreach ($node->get('field_capability_pillars')->referencedEntities() as $pillar) {
      $options[$pillar->uuid()] = $pillar->get('field_pillar_name')->value;
    }
    return $options;
  }

  /**
   * Read the form back into a deck definition.
   *
   * @return array each ['template' => id, 'node' => NodeInterface, 'selection' => array]
   */
  private function entries(FormStateInterface $form_state, NodeInterface $node): array {
    $entries = [];
    foreach ($form_state->getValue('slides', []) as $slide) {
      $template = $slide['template'] ?? '';
      if (!$template) {
        continue;
      }
      $chosen = array_values(array_filter($slide['items_' . $this->key($template)] ?? []));
      $entries[] = [
        'template' => $template,
        'node' => $node,
        'selection' => $chosen ? ['items' => $chosen] : [],
      ];
    }
    return $entries;
  }

  public function validateForm(array &$form, FormStateInterface $form_state): void {
    $node = $form_state->get('node');
    $entries = $this->entries($form_state, $node);

    if (!$entries) {
      $form_state->setErrorByName('slides', $this->t('A deck needs at least one slide.'));
      return;
    }

    // The counts are checked here so the marketer is told before a file is
    // attempted, in the same place they made the choice. The renderer checks
    // them again — it has to, since it is also reachable without this form —
    // and the two agree because both read the same /match answer.
    $templates = [];
    foreach ($this->renderer->match($node) as $template) {
      $templates[$template['id']] = $template;
    }

    foreach ($entries as $i => $entry) {
      $holds = $templates[$entry['template']]['holds']['items'] ?? NULL;
      if (!$holds) {
        continue;
      }
      $chosen = count($entry['selection']['items'] ?? []);
      if ($chosen === 0) {
        $chosen = $holds['have'];
      }
      if ($chosen < $holds['min'] || $chosen > $holds['max']) {
        $form_state->setErrorByName(
          'slides][' . $i . '][items_' . $this->key($entry['template']),
          $this->t('Slide @n: you chose @chosen, and "@name" holds @min–@max.', [
            '@n' => $i + 1,
            '@chosen' => $chosen,
            '@name' => $templates[$entry['template']]['name'],
            '@min' => $holds['min'],
            '@max' => $holds['max'],
          ])
        );
      }
    }
  }

  public function submitForm(array &$form, FormStateInterface $form_state): void {
    $node = $form_state->get('node');
    $entries = $this->entries($form_state, $node);

    try {
      $deck = $this->renderer->renderDeck($entries, $node->label());
    }
    catch (\RuntimeException $e) {
      $this->messenger()->addError($this->t('The deck could not be generated. @reason', ['@reason' => $e->getMessage()]));
      return;
    }

    // The definition is saved only once the deck exists. A deck in this POC is
    // a thing somebody made, not a thing somebody drafted.
    DeckGeneration::saveDeck(
      $this->deckId($node),
      $node->label(),
      $this->currentUser()->getAccountName() ?: 'anonymous',
      $entries
    );

    $form_state->setResponse(new Response($deck['body'], 200, [
      'Content-Type' => 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'Content-Disposition' => 'attachment; filename="' . $deck['filename'] . '"',
      'Content-Length' => strlen($deck['body']),
      'Cache-Control' => 'no-store',
    ]));
  }

}
