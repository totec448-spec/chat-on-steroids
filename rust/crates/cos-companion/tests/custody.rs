//! Which browser gets a waiting message when the extension runs in two (`openingHeldElsewhere`,
//! `chatHeldElsewhere` and `inputHeldElsewhere` in `bridge.ts`).

use cos_companion::StatusCall;
use cos_companion::custody::Custody;
use cos_types::bridge::{ClosePlanner, PendingBrowserInput, StatusInput};
use cos_types::json::True;
use cos_types::state::InputLifetime;

const CHAT: &str = "a1a1a1a1-0000-4000-8000-00000000b001";
const A: &str = "browseraaaaaaaaaaaa1";
const B: &str = "browserbbbbbbbbbbbb2";
const T0: u64 = 1_767_225_600_000;

fn pass(browser: Option<&str>, open: &[&str]) -> StatusCall {
    StatusCall {
        post: true,
        browser: browser.map(str::to_owned),
        open_conversations: open.iter().map(|chat| (*chat).to_owned()).collect(),
        ..StatusCall::default()
    }
}

fn pending(id: &str, conversation: Option<&str>) -> StatusInput {
    let offer: PendingBrowserInput =
        serde_json::from_value(serde_json::json!({ "id": id, "conversationId": conversation }))
            .expect("an offer");
    StatusInput::Pending(offer)
}

fn ids(inputs: &[StatusInput]) -> Vec<&str> {
    inputs
        .iter()
        .map(|input| match input {
            StatusInput::Pending(pending) => pending.id.as_str(),
            StatusInput::Close(close) => close.id.as_str(),
        })
        .collect()
}

#[test]
fn a_message_for_a_chat_goes_to_the_browser_that_has_it_open() {
    let custody = Custody::default();
    let work = || vec![pending("to-chat", Some(CHAT))];
    assert_eq!(
        ids(&custody.hand_out(&pass(Some(A), &[CHAT]), work(), T0)),
        ["to-chat"]
    );
    assert!(
        custody
            .hand_out(&pass(Some(B), &[]), work(), T0 + 1)
            .is_empty(),
        "B does not have the chat A holds"
    );
    assert_eq!(
        ids(&custody.hand_out(&pass(Some(B), &[]), work(), T0 + 60_000)),
        ["to-chat"],
        "A stopped polling a minute ago"
    );
}

#[test]
fn a_new_chat_belongs_to_the_first_browser_handed_it_while_that_browser_polls() {
    let custody = Custody::default();
    let work = || vec![pending("opening", None)];
    assert_eq!(
        ids(&custody.hand_out(&pass(Some(A), &[]), work(), T0)),
        ["opening"]
    );
    assert!(
        custody
            .hand_out(&pass(Some(B), &[]), work(), T0 + 10)
            .is_empty()
    );
    assert_eq!(
        ids(&custody.hand_out(&pass(Some(A), &[]), work(), T0 + 20)),
        ["opening"]
    );
    assert_eq!(
        ids(&custody.hand_out(&pass(Some(B), &[]), work(), T0 + 60_021)),
        ["opening"],
        "A lapsed; B takes it over"
    );
    assert!(
        custody
            .hand_out(&pass(Some(A), &[]), work(), T0 + 60_022)
            .is_empty()
    );
}

#[test]
fn a_pass_without_a_browser_id_and_a_planner_to_close_are_never_held_back() {
    let custody = Custody::default();
    custody.hand_out(
        &pass(Some(A), &[CHAT]),
        vec![pending("held", Some(CHAT))],
        T0,
    );
    let close = StatusInput::Close(ClosePlanner {
        id: "planner".into(),
        owner: Some("doc".into()),
        lifetime: InputLifetime::TemporaryPlanner,
        close: True,
        retire: True,
        conversation_id: Some(CHAT.into()),
    });
    assert_eq!(
        ids(&custody.hand_out(&pass(None, &[]), vec![pending("held", Some(CHAT))], T0 + 1)),
        ["held"]
    );
    assert_eq!(
        ids(&custody.hand_out(
            &pass(Some(B), &[]),
            vec![pending("held", Some(CHAT)), close],
            T0 + 2
        )),
        ["planner"]
    );
}
